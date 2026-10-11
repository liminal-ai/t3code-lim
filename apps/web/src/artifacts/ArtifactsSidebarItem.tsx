// Fork-only (artifacts): the sidebar's Artifacts button, beside Comms in the
// utility row (one seam line in SidebarChrome.tsx).
import { useNavigate } from "@tanstack/react-router";
import { LibraryIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export function ArtifactsSidebarItem(props: { readonly onNavigate: () => void }) {
  const navigate = useNavigate();
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Artifacts"
              size="icon"
              onClick={() => {
                props.onNavigate();
                void navigate({ to: "/artifacts", search: {} });
              }}
            >
              <LibraryIcon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Artifacts</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
