const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "src");

const replacements = [
  {
    find: /from\s+["']\.\.\/api\/client["']/g,
    replace: 'from "../../../services/api/client"',
  },
  {
    find: /from\s+["']\.\.\/\.\.\/api\/client["']/g,
    replace: 'from "../../../services/api/client"',
  },
  {
    find: /from\s+["']\.\.\/utils\/dateFormatter["']/g,
    replace: 'from "../../../utils/dateFormatter"',
  },
  {
    find: /\.\.\/pages\/EmployeesData\.css/g,
    replace: "../../employees/pages/EmployeesData.css",
  },
];

function processFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");

  replacements.forEach(({ find, replace }) => {
    content = content.replace(find, replace);
  });

  fs.writeFileSync(filePath, content);
}

function walk(dir) {
  const files = fs.readdirSync(dir);

  files.forEach((file) => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      walk(fullPath);
    } else if (file.endsWith(".js") || file.endsWith(".jsx")) {
      processFile(fullPath);
    }
  });
}

console.log("🔧 Fixing imports across project...");
walk(rootDir);
console.log("✅ Import fixing completed!");