#!/usr/bin/env node
/**
 * Regenerates sentinel-bounded regions across the portfolio site:
 *   - docs/plugins/index.html  <!-- BEGIN:PLUGIN-CARDS --> + <!-- BEGIN:JSONLD -->
 *   - docs/index.html          <!-- BEGIN:PROJECTS-PLUGINS --> + <!-- BEGIN:PROJECTS-OTHER -->
 *                              + <!-- BEGIN:POSTS -->
 *   - docs/index.html hero plugin count (#hero-plugin-count)
 *   - docs/sitemap.xml lastmod fields
 *
 * Source of truth for plugins:
 *   https://raw.githubusercontent.com/robworks-code/robworks-claude-code-plugins/main/.claude-plugin/marketplace.json
 *
 * Override with a local file path for offline builds:
 *   MARKETPLACE_JSON_PATH=../robworks-claude-code-plugins/.claude-plugin/marketplace.json node scripts/build-site.js
 *
 * Idempotent: a second run produces zero diff.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const PORTFOLIO_PATH = path.join(ROOT, "docs", "index.html");
const PLUGINS_PATH = path.join(ROOT, "docs", "plugins", "index.html");
const SITEMAP_PATH = path.join(ROOT, "docs", "sitemap.xml");
const PROJECTS_PATH = path.join(ROOT, "data", "projects.json");
const POSTS_PATH = path.join(ROOT, "data", "posts.json");

const MARKETPLACE_NAME = "robworks-claude-code-plugins";
const SITE_URL = "https://code.robworks.info";
const PLUGINS_URL = `${SITE_URL}/plugins`;
const CATALOG_URL = "https://raw.githubusercontent.com/robworks-code/robworks-claude-code-plugins/main/.claude-plugin/marketplace.json";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function refUrl(plugin) {
  const repo = plugin.source?.repo;
  if (!repo) return null;
  if (plugin.source?.sha) return `https://github.com/${repo}/commit/${plugin.source.sha}`;
  if (plugin.source?.ref) return `https://github.com/${repo}/releases/tag/${plugin.source.ref}`;
  return null;
}

function refLabel(plugin) {
  if (plugin.source?.ref) return plugin.source.ref;
  if (plugin.source?.sha) return plugin.source.sha.slice(0, 7);
  return null;
}

function repoUrl(plugin) {
  return plugin.source?.repo ? `https://github.com/${plugin.source.repo}` : plugin.repository || "";
}

/**
 * The catalog is not uniformly licensed, so every licensing claim on the page
 * is derived from marketplace.json rather than written by hand. A plugin that
 * is not open source has to say so before someone installs it, not after.
 */
function licenseId(plugin) {
  return plugin.license || null;
}

function licenseUrl(plugin) {
  const id = licenseId(plugin);
  if (!id) return undefined;
  if (id === "MIT") return "https://opensource.org/licenses/MIT";
  return `https://spdx.org/licenses/${id}.html`;
}

/** Plugins whose license is anything other than MIT, in catalog order. */
function nonMitPlugins(plugins) {
  return plugins.filter((p) => licenseId(p) && licenseId(p) !== "MIT");
}

/**
 * OSI-approved licenses this catalog knows how to describe as open source.
 *
 * An allowlist rather than a denylist of the restricted ones: an unrecognised
 * license defaults to the cautious description, which over-warns. Getting it
 * the other way round would publish "open source, use it at work" about terms
 * that say no such thing, which is the failure that matters.
 */
const OPEN_SOURCE_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MPL-2.0",
  "GPL-3.0",
  "GPL-2.0",
  "LGPL-3.0",
  "AGPL-3.0",
]);

/** Non-MIT plugins that are still open source, in catalog order. */
function otherOpenSourcePlugins(plugins) {
  return nonMitPlugins(plugins).filter((p) => OPEN_SOURCE_LICENSES.has(licenseId(p)));
}

/** Plugins whose license is source-available rather than open source. */
function restrictedPlugins(plugins) {
  return nonMitPlugins(plugins).filter((p) => !OPEN_SOURCE_LICENSES.has(licenseId(p)));
}

/** The prose answer to "are these plugins free?", generated from the catalog. */
function licensingAnswer(plugins) {
  const odd = nonMitPlugins(plugins);
  const credentials =
    "Some need third-party credentials (a Namecheap API key, a Google Analytics property, a QuikGIF license) that you configure separately — the plugin never charges you.";
  if (odd.length === 0) {
    return `Yes. Every plugin is MIT-licensed and free to install and use. ${credentials}`;
  }
  // Split by what the licenses actually say. This sentence used to describe
  // every non-MIT plugin in BUSL's terms, because BUSL was the only one there
  // was; the first Apache-2.0 plugin was then published as "source-available
  // rather than open source ... requiring a commercial license", which is not
  // what Apache-2.0 says and is not something to be wrong about in public.
  const restricted = restrictedPlugins(plugins);
  const otherOss = otherOpenSourcePlugins(plugins);
  const list = (ps) => ps.map((p) => `${p.name} (${licenseId(p)})`).join(", ");
  const parts = [
    `Free to install, and free to use as an individual — including for paid work.`,
    `Most plugins here are MIT-licensed.`,
  ];
  if (otherOss.length) {
    parts.push(
      `${list(otherOss)} ${otherOss.length === 1 ? "is" : "are"} open source under a different license, with the same freedom to use at work.`,
    );
  }
  if (restricted.length) {
    parts.push(
      `${list(restricted)} ${restricted.length === 1 ? "is" : "are"} source-available rather than open source: ` +
        `free for any individual acting on their own initiative, with adoption across an organization requiring a commercial license.`,
    );
  }
  parts.push(`Check the license on each card before adopting one at work.`, credentials);
  return parts.join(" ");
}

/**
 * Guard against the failure this function was written to fix: a blanket "every
 * plugin is MIT" claim left behind in hand-written copy after a non-MIT plugin
 * joined the catalog. Static prose outside the sentinels cannot be regenerated,
 * so it is asserted instead.
 */
function assertNoBlanketMitClaim(html, plugins, label) {
  if (nonMitPlugins(plugins).length === 0) return;
  const offenders = [
    /every plugin is mit/i,
    /all plugins are mit/i,
    /\bfree, mit-licensed\b/i,
    /every plugin is[^.]{0,40}\bmit-licensed\b/i,
  ].filter((re) => re.test(html));
  if (offenders.length) {
    throw new Error(
      `${label}: the catalog contains a non-MIT plugin (${nonMitPlugins(plugins)
        .map((p) => p.name)
        .join(", ")}) but the page still claims every plugin is MIT — ` +
        `matched ${offenders.map(String).join(", ")}`,
    );
  }
}

function operatingSystemFor(plugin) {
  const tags = Array.isArray(plugin.tags) ? plugin.tags.map((t) => t.toLowerCase()) : [];
  if (tags.includes("macos") && !tags.includes("linux") && !tags.includes("windows")) return "macOS";
  return "macOS, Linux, Windows";
}

function renderPluginCard(plugin) {
  const installCmd = `claude plugin install ${plugin.name}@${MARKETPLACE_NAME}`;
  const tags = Array.isArray(plugin.tags) ? plugin.tags : [];
  const rl = refLabel(plugin);
  const ru = refUrl(plugin);
  const rp = repoUrl(plugin);
  const name = escapeHtml(plugin.name);
  const cmd = escapeHtml(installCmd);

  const lines = [];
  lines.push(`          <article class="card" id="plugin-${name}">`);
  lines.push(`            <div class="card-header">`);
  lines.push(`              <h3>${name}</h3>`);
  if (plugin.category) {
    lines.push(`              <span class="badge">${escapeHtml(plugin.category)}</span>`);
  }
  lines.push(`            </div>`);
  if (plugin.description) {
    lines.push(`            <p class="description">${escapeHtml(plugin.description)}</p>`);
  }
  if (tags.length) {
    lines.push(`            <div class="tags">`);
    for (const t of tags) {
      lines.push(`              <span class="tag">${escapeHtml(t)}</span>`);
    }
    lines.push(`            </div>`);
  }
  lines.push(`            <div class="terminal">`);
  lines.push(`              <div class="terminal-body">`);
  lines.push(`                <div class="terminal-line">`);
  lines.push(`                  <code class="terminal-cmd">${cmd}</code>`);
  lines.push(`                </div>`);
  lines.push(`                <div class="terminal-actions">`);
  lines.push(`                  <button class="copy-btn" data-copy="${cmd}" aria-label="Copy install command for ${name}">copy</button>`);
  lines.push(`                </div>`);
  lines.push(`              </div>`);
  lines.push(`            </div>`);
  const lic = licenseId(plugin);
  if (lic) {
    const licUrl = licenseUrl(plugin);
    const licInner = licUrl
      ? `<a href="${escapeHtml(licUrl)}">${escapeHtml(lic)}</a>`
      : escapeHtml(lic);
    // Only the genuinely restricted licenses get the badge. Tagging every
    // non-MIT card "source-available" mislabelled Apache-2.0, which is OSI
    // open source and carries no such restriction.
    const oss = OPEN_SOURCE_LICENSES.has(lic)
      ? ""
      : ` <span class="license-note">source-available</span>`;
    lines.push(`            <p class="license">license: ${licInner}${oss}</p>`);
  }
  lines.push(`            <div class="card-footer">`);
  if (rl) {
    const verInner = ru
      ? `<a href="${escapeHtml(ru)}">${escapeHtml(rl)}</a>`
      : escapeHtml(rl);
    lines.push(`              <span class="pinned">ref: ${verInner}</span>`);
  } else {
    lines.push(`              <span class="pinned">tracks default branch</span>`);
  }
  if (rp) {
    lines.push(`              <a class="repo-link" href="${escapeHtml(rp)}">source →</a>`);
  }
  lines.push(`            </div>`);
  lines.push(`          </article>`);
  return lines.join("\n");
}

function renderProjectPluginCard(plugin) {
  const tags = Array.isArray(plugin.tags) ? plugin.tags.slice(0, 3) : [];
  const rl = refLabel(plugin);
  const name = escapeHtml(plugin.name);
  const lines = [];
  lines.push(`          <article class="card">`);
  lines.push(`            <div class="card-header">`);
  lines.push(`              <h3>${name}</h3>`);
  if (plugin.category) {
    lines.push(`              <span class="badge">${escapeHtml(plugin.category)}</span>`);
  }
  lines.push(`            </div>`);
  if (plugin.description) {
    lines.push(`            <p class="description">${escapeHtml(plugin.description)}</p>`);
  }
  if (tags.length) {
    lines.push(`            <div class="tags">`);
    for (const t of tags) {
      lines.push(`              <span class="tag">${escapeHtml(t)}</span>`);
    }
    lines.push(`            </div>`);
  }
  lines.push(`            <div class="card-footer">`);
  if (rl) {
    lines.push(`              <span class="pinned">${escapeHtml(rl)}</span>`);
  } else {
    lines.push(`              <span class="pinned">tracks default branch</span>`);
  }
  lines.push(`              <a class="repo-link" href="/plugins/#plugin-${name}">view →</a>`);
  lines.push(`            </div>`);
  lines.push(`          </article>`);
  return lines.join("\n");
}

function renderOtherProjectCard(project) {
  const tags = Array.isArray(project.tags) ? project.tags.slice(0, 4) : [];
  const lines = [];
  lines.push(`          <article class="card">`);
  lines.push(`            <div class="card-header">`);
  lines.push(`              <h3>${escapeHtml(project.name)}</h3>`);
  if (project.category) {
    lines.push(`              <span class="badge">${escapeHtml(project.category)}</span>`);
  }
  lines.push(`            </div>`);
  if (project.description) {
    lines.push(`            <p class="description">${escapeHtml(project.description)}</p>`);
  }
  if (tags.length) {
    lines.push(`            <div class="tags">`);
    for (const t of tags) {
      lines.push(`              <span class="tag">${escapeHtml(t)}</span>`);
    }
    lines.push(`            </div>`);
  }
  lines.push(`            <div class="card-footer">`);
  lines.push(`              <span class="pinned">project</span>`);
  if (project.url) {
    lines.push(`              <a class="repo-link" href="${escapeHtml(project.url)}">view →</a>`);
  } else if (project.source) {
    lines.push(`              <a class="repo-link" href="${escapeHtml(project.source)}">source →</a>`);
  }
  lines.push(`            </div>`);
  lines.push(`          </article>`);
  return lines.join("\n");
}

function renderPostCard(post) {
  const date = escapeHtml(post.date || "");
  const lines = [];
  lines.push(`          <article class="card">`);
  lines.push(`            <div class="card-header">`);
  lines.push(`              <h3>${escapeHtml(post.title)}</h3>`);
  if (date) lines.push(`              <span class="badge">${date}</span>`);
  lines.push(`            </div>`);
  if (post.summary) {
    lines.push(`            <p class="description">${escapeHtml(post.summary)}</p>`);
  }
  lines.push(`            <div class="card-footer">`);
  lines.push(`              <span class="pinned">${date}</span>`);
  if (post.url) {
    lines.push(`              <a class="repo-link" href="${escapeHtml(post.url)}">read →</a>`);
  }
  lines.push(`            </div>`);
  lines.push(`          </article>`);
  return lines.join("\n");
}

function renderPluginsJsonLd(plugins) {
  const softwareNodes = plugins.map((p) => {
    const tags = Array.isArray(p.tags) ? p.tags.slice() : [];
    const keywords = Array.from(new Set([...tags, "claude-code", "plugin"])).join(", ");
    return {
      "@type": "SoftwareApplication",
      "@id": `${PLUGINS_URL}/#sw-${p.name}`,
      "name": p.name,
      "applicationCategory": "DeveloperApplication",
      "applicationSubCategory": "Claude Code plugin",
      "operatingSystem": operatingSystemFor(p),
      "description": p.description || "",
      "softwareVersion": (p.source?.ref || "").replace(/^v/, "") || undefined,
      "license": licenseUrl(p),
      "url": repoUrl(p),
      "codeRepository": repoUrl(p),
      "downloadUrl": refUrl(p) || undefined,
      "keywords": keywords,
      "author": { "@id": "https://robworks.info/#org" },
      "publisher": { "@id": "https://robworks.info/#org" },
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
    };
  });

  const graph = [
    {
      "@type": "Organization",
      "@id": "https://robworks.info/#org",
      "name": "Robworks Software LLC",
      "url": "https://robworks.info",
      "founder": { "@type": "Person", "name": "Ryan Robson" },
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      "url": `${SITE_URL}/`,
      "name": "Ryan Robson — Robworks Software LLC",
      "publisher": { "@id": "https://robworks.info/#org" },
      "inLanguage": "en-US",
    },
    {
      "@type": "BreadcrumbList",
      "@id": `${PLUGINS_URL}/#breadcrumb`,
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "name": "Home", "item": `${SITE_URL}/` },
        { "@type": "ListItem", "position": 2, "name": "Plugins", "item": `${PLUGINS_URL}/` },
      ],
    },
    {
      "@type": "CollectionPage",
      "@id": `${PLUGINS_URL}/#page`,
      "url": `${PLUGINS_URL}/`,
      "name": "Robworks Claude Code Plugins",
      "description":
        "A personal Claude Code plugin marketplace — MCP servers and developer-workflow plugins by Ryan Robson and Robworks Software LLC.",
      "inLanguage": "en-US",
      "isPartOf": { "@id": `${SITE_URL}/#website` },
      "publisher": { "@id": "https://robworks.info/#org" },
      "mainEntity": { "@id": `${PLUGINS_URL}/#plugins` },
      "primaryImageOfPage": `${PLUGINS_URL}/og-image.png`,
      "breadcrumb": { "@id": `${PLUGINS_URL}/#breadcrumb` },
    },
    {
      "@type": "ItemList",
      "@id": `${PLUGINS_URL}/#plugins`,
      "name": "Claude Code plugins by Robworks Software LLC",
      "numberOfItems": plugins.length,
      "itemListElement": plugins.map((p, i) => ({
        "@type": "ListItem",
        "position": i + 1,
        "url": `${PLUGINS_URL}/#plugin-${p.name}`,
        "item": { "@id": `${PLUGINS_URL}/#sw-${p.name}` },
      })),
    },
    ...softwareNodes,
    {
      "@type": "FAQPage",
      "@id": `${PLUGINS_URL}/#faq`,
      "mainEntity": [
        {
          "@type": "Question",
          "name": "What is a Claude Code plugin marketplace?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text":
              "A catalog of plugins — MCP servers, slash commands, agents, skills, and hooks — you can add to Claude Code in one command. Once added, you can discover and install any plugin from your terminal, and stay in sync with the latest pinned releases.",
          },
        },
        {
          "@type": "Question",
          "name": "How do I install a plugin from this marketplace?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text":
              "Run claude plugin marketplace add robworks-code/robworks-claude-code-plugins once to register the catalog, then claude plugin install <name>@robworks-claude-code-plugins for any plugin above. Inside an interactive Claude Code session, the slash-command equivalents are /plugin marketplace add … and /plugin install ….",
          },
        },
        {
          "@type": "Question",
          "name": "What is an MCP server?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text":
              "An MCP (Model Context Protocol) server exposes tools and resources to an LLM client like Claude Code. Every plugin on this page bundles an MCP server — invoke its tools from plain-language prompts in Claude Code, no custom client code required.",
          },
        },
        {
          "@type": "Question",
          "name": "Are these plugins free?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": licensingAnswer(plugins),
          },
        },
        {
          "@type": "Question",
          "name": "Can I contribute a plugin?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text":
              "Yes — open an issue or PR at the source repository. See Contributing a plugin in the README for the criteria.",
          },
        },
        {
          "@type": "Question",
          "name": "How do I pin a plugin to a specific version?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text":
              "Each plugin entry in marketplace.json carries a ref (branch or tag) or sha (exact commit). Every plugin on this page is already pinned to a tagged release; see the ref: link on each card for the exact version.",
          },
        },
      ],
    },
  ];

  const payload = { "@context": "https://schema.org", "@graph": graph };
  return JSON.stringify(payload, null, 2);
}

function replaceBetween(content, beginMarker, endMarker, replacement) {
  const begin = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`Sentinels not found: ${beginMarker} / ${endMarker}`);
  }
  const before = content.slice(0, begin + beginMarker.length);
  const after = content.slice(end);
  return `${before}\n${replacement}\n${after}`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "robworks-code-build" } }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

async function loadMarketplace() {
  const override = process.env.MARKETPLACE_JSON_PATH;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.resolve(ROOT, override);
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  }
  try {
    const body = await fetchUrl(CATALOG_URL);
    return JSON.parse(body);
  } catch (err) {
    throw new Error(
      `Failed to fetch ${CATALOG_URL}: ${err.message}. ` +
        `Set MARKETPLACE_JSON_PATH to a local marketplace.json for offline builds.`
    );
  }
}

async function main() {
  const marketplace = await loadMarketplace();
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const projects = JSON.parse(fs.readFileSync(PROJECTS_PATH, "utf8"));
  const otherProjects = Array.isArray(projects.other) ? projects.other : [];
  const postsData = JSON.parse(fs.readFileSync(POSTS_PATH, "utf8"));
  const posts = Array.isArray(postsData.posts) ? postsData.posts : [];

  // --- docs/plugins/index.html: cards + JSON-LD ---
  let pluginsHtml = fs.readFileSync(PLUGINS_PATH, "utf8");
  const cardsBlock = plugins.map(renderPluginCard).join("\n\n");
  pluginsHtml = replaceBetween(pluginsHtml, "<!-- BEGIN:PLUGIN-CARDS -->", "<!-- END:PLUGIN-CARDS -->", cardsBlock);
  const jsonLd = renderPluginsJsonLd(plugins);
  const jsonLdBlock = `  <script type="application/ld+json">\n${jsonLd}\n  </script>`;
  pluginsHtml = replaceBetween(pluginsHtml, "<!-- BEGIN:JSONLD -->", "<!-- END:JSONLD -->", jsonLdBlock);
  // The visible FAQ answer and the FAQPage JSON-LD answer are the same sentence,
  // so they are generated from one source rather than kept in sync by hand.
  const faqLicense = `          <p>${escapeHtml(licensingAnswer(plugins))}</p>`;
  pluginsHtml = replaceBetween(pluginsHtml, "<!-- BEGIN:FAQ-LICENSE -->", "<!-- END:FAQ-LICENSE -->", faqLicense);
  // refresh hero count + plugin-count text in baked SSR (matches what runtime fetch would set)
  pluginsHtml = pluginsHtml.replace(
    /<strong id="hero-plugin-count">\d+<\/strong>/,
    `<strong id="hero-plugin-count">${plugins.length}</strong>`
  );
  pluginsHtml = pluginsHtml.replace(
    /<p class="section-meta" id="plugin-count">\d+ plugins? available<\/p>/,
    `<p class="section-meta" id="plugin-count">${plugins.length} plugin${plugins.length === 1 ? "" : "s"} available</p>`
  );
  assertNoBlanketMitClaim(pluginsHtml, plugins, "docs/plugins/index.html");
  fs.writeFileSync(PLUGINS_PATH, pluginsHtml);
  console.log(`✓ docs/plugins/index.html — ${plugins.length} plugin cards + JSON-LD`);

  // --- docs/index.html: projects subgrids + posts + hero count ---
  let portfolioHtml = fs.readFileSync(PORTFOLIO_PATH, "utf8");
  const projectsPluginsBlock = plugins.map(renderProjectPluginCard).join("\n\n");
  portfolioHtml = replaceBetween(
    portfolioHtml,
    "<!-- BEGIN:PROJECTS-PLUGINS -->",
    "<!-- END:PROJECTS-PLUGINS -->",
    projectsPluginsBlock
  );
  const otherBlock = otherProjects.length
    ? otherProjects.map(renderOtherProjectCard).join("\n\n")
    : `          <article class="card empty-state">\n            <div class="card-header"><h3>more soon</h3><span class="badge">draft</span></div>\n            <p class="description">Other projects will land here as they ship.</p>\n            <div class="card-footer"><span class="pinned">queue</span><a class="repo-link" href="https://github.com/ringo380">github →</a></div>\n          </article>`;
  portfolioHtml = replaceBetween(
    portfolioHtml,
    "<!-- BEGIN:PROJECTS-OTHER -->",
    "<!-- END:PROJECTS-OTHER -->",
    otherBlock
  );
  const postsBlock = posts.length
    ? posts.map(renderPostCard).join("\n\n")
    : `          <article class="card empty-state">\n            <div class="card-header">\n              <h3>coming soon</h3>\n              <span class="badge">draft</span>\n            </div>\n            <p class="description">First posts are in the queue — incident write-ups, plugin development notes, and short-form essays on building solo. No newsletter yet; check back, or follow on GitHub for now.</p>\n            <div class="card-footer">\n              <span class="pinned">writing.todo</span>\n              <a class="repo-link" href="https://github.com/ringo380">github →</a>\n            </div>\n          </article>`;
  portfolioHtml = replaceBetween(portfolioHtml, "<!-- BEGIN:POSTS -->", "<!-- END:POSTS -->", postsBlock);
  portfolioHtml = portfolioHtml.replace(
    /<strong id="hero-plugin-count">\d+<\/strong>/,
    `<strong id="hero-plugin-count">${plugins.length}</strong>`
  );
  fs.writeFileSync(PORTFOLIO_PATH, portfolioHtml);
  console.log(`✓ docs/index.html — ${plugins.length} plugin sub-cards + ${otherProjects.length} other + ${posts.length} posts`);

  // --- docs/sitemap.xml: lastmod ---
  const sitemap = fs.readFileSync(SITEMAP_PATH, "utf8");
  const updatedSitemap = sitemap.replace(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g, `<lastmod>${today()}</lastmod>`);
  if (updatedSitemap !== sitemap) {
    fs.writeFileSync(SITEMAP_PATH, updatedSitemap);
    console.log(`✓ docs/sitemap.xml — lastmod → ${today()}`);
  } else {
    console.log(`· docs/sitemap.xml — lastmod already ${today()}`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
