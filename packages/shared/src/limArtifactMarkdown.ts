// Fork-only (artifacts): markdown artifacts rendered on the server for signed
// view links (`/a/<token>`; PROPOSAL §2.7). The same parser, plugins and
// sanitizer as the app's chat markdown, so raw HTML in a document is
// sanitized exactly as it is in the app. The server serializes the tree.
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

const processor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(CHAT_MARKDOWN_REHYPE_PLUGINS);

/** The sanitized HTML syntax tree (hast `Root`) of a markdown document. */
export function limArtifactMarkdownTree(markdown: string): unknown {
  return processor.runSync(processor.parse(markdown));
}
