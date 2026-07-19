const sharp = require('sharp');
const fs = require('fs');

const svgContent = fs.readFileSync('./public/favicon.svg');

async function generate() {
  await sharp(svgContent).resize(192,192).png()
    .toFile('./public/icon-192.png');
  await sharp(svgContent).resize(512,512).png()
    .toFile('./public/icon-512.png');
  await sharp(svgContent).resize(32,32).png()
    .toFile('./public/favicon-32.png');
  console.log('Icons generated!');
}

generate();
