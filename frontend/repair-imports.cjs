const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src");

function walk(dir, files = []) {
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);

    if (fs.statSync(full).isDirectory()) {
      walk(full, files);
    } else if (file.endsWith(".js") || file.endsWith(".jsx")) {
      files.push(full);
    }
  });

  return files;
}

function findFile(filename, dir) {
  let result = null;

  function search(d) {
    const files = fs.readdirSync(d);

    for (const file of files) {
      const full = path.join(d, file);

      if (fs.statSync(full).isDirectory()) {
        search(full);
      } else if (file === filename) {
        result = full;
      }
    }
  }

  search(dir);
  return result;
}

const files = walk(SRC);

files.forEach(file => {
  let content = fs.readFileSync(file, "utf8");

  const imports = content.match(/import .* from ["'](.*?)["']/g);

  if (!imports) return;

  imports.forEach(line => {
    const match = line.match(/["'](.*?)["']/);
    if (!match) return;

    const importPath = match[1];

    if (importPath.startsWith(".") || importPath.startsWith("@")) return;

    const filename = importPath.split("/").pop();

    const found = findFile(filename, SRC);

    if (found) {
      const relative = "@/" + path.relative(SRC, found).replace(/\\/g, "/");

      const fixed = line.replace(importPath, relative);

      content = content.replace(line, fixed);

      console.log(`Fixed: ${file}`);
    }
  });

  fs.writeFileSync(file, content);
});

console.log("🚀 Import repair complete");