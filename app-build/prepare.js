// Copies the game into www/ and swaps the Google Fonts link for font files
// packed inside the app, so the game looks the same with no internet.
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, ".."), www = path.join(__dirname, "www");
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(path.join(www, "fonts"), { recursive: true });

const files = ["index.html", "styles.css", "game.js", "online.js", "networks.js", "favicon.svg", "favicon-32.png", "apple-touch-icon.png"];
for (const f of files) fs.copyFileSync(path.join(root, f), path.join(www, f));

const fonts = [["Lilita One", "lilita-one", 400], ["Fredoka", "fredoka", 500], ["Fredoka", "fredoka", 600], ["Fredoka", "fredoka", 700]];
let css = "";
for (const [family, pkg, weight] of fonts) {
  const file = `${pkg}-latin-${weight}-normal.woff2`;
  const src = path.join(__dirname, "node_modules", "@fontsource", pkg, "files", file);
  if (!fs.existsSync(src)) throw new Error("Font file not found: " + src);
  fs.copyFileSync(src, path.join(www, "fonts", file));
  css += `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap; src: url("${file}") format("woff2"); }\n`;
}
fs.writeFileSync(path.join(www, "fonts", "fonts.css"), css);

let html = fs.readFileSync(path.join(www, "index.html"), "utf8");
const before = html;
html = html.replace(/<link rel="preconnect"[^>]*>\s*/g, "")
           .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link rel="stylesheet" href="fonts/fonts.css">')
           .replace(/<link rel="manifest"[^>]*>\s*/g, "");
if (html === before || html.includes("fonts.googleapis.com")) throw new Error("Could not replace the Google Fonts link in index.html");
fs.writeFileSync(path.join(www, "index.html"), html);
console.log("Game copied to www/ with", fonts.length, "font files");
