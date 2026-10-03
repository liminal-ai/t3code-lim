/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import {
  ClaudeAgentSdkQueryRunner,
  createClaudeAdapterV2,
  makeClaudeAgentSdkQueryRunner,
  type ClaudeAdapterV2DriverEnv,
  type ClaudeCreateQuery,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeScopedLimitNames } from "../Layers/claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../Layers/claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../Layers/resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";

const STOCK_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: STOCK_DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ModelManifest.ModelManifest
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

/**
 * One Claude Code driver kind. The stock `claudeAgent` driver is the spec with no options;
 * Claude-LHC (`ClaudeLhcDriver`) runs each session's query through its sidecar.
 */
export interface ClaudeDriverSpec<Settings extends ClaudeSettings> {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly configSchema: Schema.Codec<Settings, any>;
  /** This instance's query: the SDK's own `query` when absent. Gets the server's T3 home. */
  readonly createQuery?: (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly baseDir: string;
  }) => ClaudeCreateQuery;
  /** Set when sessions of this kind can't be forked; a fork fails with it. */
  readonly forkRefusal?: string;
  /** Why this server can't run this kind (reported as an error status), or undefined. */
  readonly unavailableReason?: (
    environment: NodeJS.ProcessEnv,
    baseDir: string,
  ) => string | undefined;
  /** Maps the stock continuation key, so instances of different kinds never share one. */
  readonly continuationGroupKey?: (stockKey: string) => string;
}

export const makeClaudeDriver = <Settings extends ClaudeSettings>(
  spec: ClaudeDriverSpec<Settings>,
): ProviderDriver<Settings, ClaudeDriverEnv> => ({
  driverKind: spec.driverKind,
  metadata: {
    displayName: spec.displayName,
    supportsMultipleInstances: true,
  },
  configSchema: spec.configSchema,
  defaultConfig: (): Settings => Schema.decodeSync(spec.configSchema)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const DRIVER_KIND = spec.driverKind;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd, baseDir } = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const modelCatalog = modelManifest.current.pipe(Effect.map(resolveClaudeModelCatalog));
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies ClaudeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const stockContinuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const continuationGroupKey =
        spec.continuationGroupKey?.(stockContinuationGroupKey) ?? stockContinuationGroupKey;
      const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
      const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
        effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
          ? configDir
          : undefined,
      );
      const unavailableReason = spec.unavailableReason?.(processEnv, baseDir);
      // The runtime is missing rather than broken: `installed: false` tells clients that no turn
      // can start on this server.
      const reportUnavailable = <
        Snapshot extends { readonly status: string; readonly installed: boolean },
      >(
        draft: Snapshot,
      ): Snapshot =>
        unavailableReason === undefined || draft.status === "disabled"
          ? draft
          : { ...draft, status: "error", installed: false, message: unavailableReason };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const adapterEffect = createClaudeAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        { scopedLimitNames, onUsageLimits: (update) => snapshot.applyUsageLimits(update) },
      );
      // Claude-LHC: this instance's sessions run through its own query runner.
      const instanceQueryRunner =
        spec.createQuery === undefined && spec.forkRefusal === undefined
          ? undefined
          : yield* makeClaudeAgentSdkQueryRunner({
              ...(spec.createQuery === undefined
                ? {}
                : { createQuery: spec.createQuery({ environment: processEnv, baseDir }) }),
              ...(spec.forkRefusal === undefined ? {} : { forkRefusal: spec.forkRefusal }),
            });
      const adapterWithRunner: typeof adapterEffect =
        instanceQueryRunner === undefined
          ? adapterEffect
          : adapterEffect.pipe(
              Effect.provideService(ClaudeAgentSdkQueryRunner, instanceQueryRunner),
            );
      const orchestrationAdapter = yield* adapterWithRunner.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Claude orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        cwd,
        processEnv,
      );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = modelManifest.refreshInBackground.pipe(
        Effect.andThen(
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
                processEnv,
                cwd,
                resolveClaudeModelCatalog(manifest),
                scopedLimitNames,
                (version) =>
                  ClaudeResetCredits.readClaudeResetCredits(configDir, version).pipe(
                    Effect.provideService(HttpClient.HttpClient, httpClient),
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                  ),
              ),
            ),
            Effect.map((draft) => reportUnavailable(stampIdentity(draft))),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelManifest.current.pipe(
            Effect.flatMap((manifest) =>
              makePendingClaudeProvider(settings.provider, resolveClaudeModelCatalog(manifest)),
            ),
            Effect.map((draft) => reportUnavailable(stampIdentity(draft))),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Same rules as Codex: serialised on the config directory that holds the
      // login, one request id kept until Claude answers (a cooldown or rate
      // limit is an answer), then a re-probe.
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        Effect.gen(function* () {
          const current = yield* snapshot.getSnapshot;
          const grantId = current.usageLimits?.resetCredits?.nextCreditId;
          if (!grantId || !current.version) return "noCredit" as const;
          const version = current.version;
          return yield* resetCreditCoordinator.redeem(
            configDir,
            (requestId) =>
              ClaudeResetCredits.consumeClaudeResetCredit({
                configDir,
                accountConfigPath,
                version,
                grantId,
                requestId,
              }),
            ClaudeResetCredits.isSettledClaudeResetCreditFailure,
          );
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause._tag === "ClaudeResetCreditError"
                    ? cause.message
                    : "Claude could not redeem the reset.",
                cause,
              }),
          ),
          // Re-probe after any answer, but only a reset claims the limits
          // changed, so only a reset reports an unconfirmed refresh.
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
              yield* Cache.invalidateAll(capabilitiesProbeCache);
              const refreshed = yield* snapshot.refresh;
              const after = refreshed.usageLimits?.checkedAt;
              if (
                outcome === "reset" &&
                (after === undefined ||
                  after === before ||
                  refreshed.usageLimits?.unavailable?.reason === "probeFailed")
              ) {
                return yield* new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail:
                    "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
                });
              }
            }),
          ),
        );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
        snapshotForCwd: (cwd: string) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                discoverClaudeSkills(effectiveConfig, cwd, processEnv),
              ]).pipe(
                Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
        orchestrationAdapter,
        textGeneration,
        consumeResetCredit,
      } satisfies ProviderInstance;
    }),
});

export const ClaudeDriver = makeClaudeDriver({
  driverKind: STOCK_DRIVER_KIND,
  displayName: "Claude",
  configSchema: ClaudeSettings,
});
