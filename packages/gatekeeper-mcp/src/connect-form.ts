// The one page this gatekeeper serves that asks the user something: which MCP server to connect.
// Lives here rather than in `@gadgets/mcp-shared/html` because the gateway connector, whose endpoint
// is a deployment setting, has no equivalent page.

import { escapeHtml, PAGE_STYLE } from "@gadgets/mcp-shared/html";

// Form controls, on top of the palette and page frame every connect page shares.
const FORM_STYLE = `
  label { display: block; font-size: 14px; font-weight: 600; color: var(--strong); margin: 0 0 6px; }
  label.section { margin-top: 18px; }
  label .hint { font-weight: 400; }
  p.hint { margin: 6px 0 0; font-size: 13px; color: var(--subtle); }

  input[type=url], .header-row input { width: 100%; box-sizing: border-box; padding: 9px 11px;
                     font: inherit; background: var(--control); color: var(--text);
                     border: 1px solid var(--line); border-radius: 8px; }
  input[type=url]::placeholder, .header-row input::placeholder { color: var(--subtle); }
  input[type=url]:focus, .header-row input:focus { outline: 0; border-color: var(--brand);
                          box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent); }

  button[type=submit] { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px;
            background: var(--contrast); color: var(--on-contrast); font: inherit; font-weight: 600;
            cursor: pointer; }
  button[type=submit]:hover { opacity: .9; }

  #header-rows { display: grid; gap: 8px; margin-bottom: 8px; }
  .header-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; }
  .header-row button.remove { width: auto; margin: 0; padding: 9px 12px; border-radius: 8px;
                              border: 1px solid var(--line); background: transparent;
                              color: var(--subtle); font: inherit; cursor: pointer; }
  .header-row button.remove:hover { color: var(--text); }
  #add-header { width: auto; margin: 0; padding: 7px 12px; border-radius: 8px;
                border: 1px solid var(--line); background: transparent; color: var(--strong);
                font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
  #add-header:hover { border-color: var(--brand); }
`;

const HEADER_ROW = `
      <div class="header-row">
        <input name="headerName" type="text" placeholder="Header name" autocomplete="off" spellcheck="false" aria-label="Header name">
        <input name="headerValue" type="password" placeholder="Header value" autocomplete="off" aria-label="Header value">
        <button type="button" class="remove" aria-label="Remove header">&#10005;</button>
      </div>`;

// Adds and removes optional header rows. Values are read server-side from repeated
// `headerName`/`headerValue` fields; nothing here ever echoes a value back.
const HEADER_ROWS_SCRIPT = `
  (() => {
    const rows = document.getElementById("header-rows");
    const template = document.getElementById("header-row-template");
    document.getElementById("add-header").addEventListener("click", () => {
      rows.appendChild(template.content.cloneNode(true));
    });
    rows.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target.closest("button.remove") : null;
      if (target) target.closest(".header-row")?.remove();
    });
  })();
`;

/** Renders the endpoint prompt shown when the user starts connecting. */
export function connectFormHtml(path: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an MCP server</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main>
  <h1>Connect an MCP server</h1>
  <p class="sub">We will discover the server's tools and, if it requires authorization, take you
  through its sign-in.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="${escapeHtml(path)}">
    <label for="url">Server URL</label>
    <input id="url" type="url" name="url" placeholder="https://example.com/mcp" required autofocus>
    <p class="hint">Only connect a server you trust. Its own annotations decide which of its tools
    run without asking you and which wait for your approval, and an annotation is only as
    trustworthy as the server that sent it.</p>
    <label class="section">Headers <span class="hint">(optional)</span></label>
    <div id="header-rows">${HEADER_ROW}</div>
    <button type="button" id="add-header">+ Add header</button>
    <p class="hint">If the server expects an API key or token in a request header, name it here and
    we send it with every request. Values are kept with the connection's other credentials and
    never shown again.</p>
    <button type="submit">Continue</button>
  </form>
  <template id="header-row-template">${HEADER_ROW}</template>
  <script>${HEADER_ROWS_SCRIPT}</script>
</main></body></html>`;
}
