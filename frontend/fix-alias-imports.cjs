const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "src");

function walk(dir) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const full = path.join(dir, file);

    if (fs.statSync(full).isDirectory()) {
      walk(full);
    } else if (file.endsWith(".js") || file.endsWith(".jsx")) {
      fixFile(full);
    }
  });
}

function fixFile(file) {
  let content = fs.readFileSync(file, "utf8");

  content = content.replace(/(\.\.\/)+services\/api\/client/g, "@/services/api/client");
  content = content.replace(/(\.\.\/)+utils\/dateFormatter/g, "@/utils/dateFormatter");
  content = content.replace(/(\.\.\/)+components/g, "@/components");
  content = content.replace(/(\.\.\/)+pages/g, "@/pages");
  content = content.replace(/(\.\.\/)+features/g, "@/features");

  fs.writeFileSync(file, content);
}

console.log("⚡ Fixing imports...");
walk(root);
console.log("✅ All imports cleaned!");