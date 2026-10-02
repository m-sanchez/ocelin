import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { ocelotIcon } from "../ui/ocelin/ocelot-art.mjs";

const assets = fileURLToPath(new URL("./assets/", import.meta.url));
mkdirSync(assets, { recursive: true });
writeFileSync(
  `${assets}/update-policy.json`,
  JSON.stringify({
    publisher: process.env.OCELIN_SIGNING_PUBLISHER?.trim() || null,
  }),
);
const svg = ocelotIcon(16);
const paths = [...svg.matchAll(/<path fill="(#[a-f0-9]+)" d="([^"]+)"/g)].map(
  ([, color, path]) => {
    const tokens = path.match(/[MmhHvVzZ]|-?\d+/g);
    const polygons = [];
    let x = 0,
      y = 0,
      polygon = [],
      i = 0;
    while (i < tokens.length) {
      const command = tokens[i++];
      if (command === "M") {
        x = Number(tokens[i++]);
        y = Number(tokens[i++]);
        polygon = [[x, y]];
      } else if (command === "h") {
        x += Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command === "H") {
        x = Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command === "v") {
        y += Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command === "V") {
        y = Number(tokens[i++]);
        polygon.push([x, y]);
      } else if (command.toLowerCase() === "z") polygons.push(polygon);
    }
    return {
      color: [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)),
      polygons,
    };
  },
);
function inside(x, y, polygon) {
  let yes = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [a, b] = polygon[i],
      [c, d] = polygon[j];
    if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) yes = !yes;
  }
  return yes;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, value) {
  const data = Buffer.concat([Buffer.from(type), value]);
  const result = Buffer.alloc(data.length + 8);
  result.writeUInt32BE(value.length);
  data.copy(result, 4);
  result.writeUInt32BE(crc32(data), result.length - 4);
  return result;
}
function png(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = Math.floor((x * 16) / size) + 0.5,
        py = Math.floor((y * 16) / size) + 0.5;
      for (const p of paths)
        if (p.polygons.some((polygon) => inside(px, py, polygon))) {
          const offset = y * (size * 4 + 1) + 1 + x * 4;
          rows.set([...p.color, 255], offset);
        }
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
writeFileSync(`${assets}/ocelin.png`, png(32));
for (const size of [44, 150])
  writeFileSync(`${assets}/ocelin-${size}.png`, png(size));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = sizes.map(png);
const ico = Buffer.alloc(6 + sizes.length * 16);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(sizes.length, 4);
let imageOffset = ico.length;
for (const [index, size] of sizes.entries()) {
  const entry = 6 + index * 16;
  ico[entry] = ico[entry + 1] = size === 256 ? 0 : size;
  ico.writeUInt16LE(1, entry + 4);
  ico.writeUInt16LE(32, entry + 6);
  ico.writeUInt32LE(images[index].length, entry + 8);
  ico.writeUInt32LE(imageOffset, entry + 12);
  imageOffset += images[index].length;
}
writeFileSync(`${assets}/ocelin.ico`, Buffer.concat([ico, ...images]));
writeFileSync(
  fileURLToPath(new URL("../ui/ocelin/icon.svg", import.meta.url)),
  ocelotIcon(32),
);

const entries = [],
  central = [];
let offset = 0;
for (const name of [
  "widget.json",
  "compact.json",
  "provider.ps1",
  "README.md",
  "LICENSE",
  ...["idle", "coding", "attention", "sleeping"].flatMap((state) =>
    ["gif", "png"].map((extension) => `assets/${state}.${extension}`),
  ),
]) {
  const filename = Buffer.from(name);
  const data = readFileSync(
    new URL(
      name === "LICENSE"
        ? "../LICENSE"
        : `./integrations/taskbar-widgets/${name}`,
      import.meta.url,
    ),
  );
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(20, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt16LE(33, 14);
  directory.writeUInt32LE(crc32(data), 16);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(filename.length, 28);
  directory.writeUInt32LE(offset, 42);
  entries.push(local, filename, data);
  central.push(directory, filename);
  offset += local.length + filename.length + data.length;
}
const directory = Buffer.concat(central),
  end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(central.length / 2, 8);
end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
writeFileSync(
  new URL("./integrations/Ocelin.twidget", import.meta.url),
  Buffer.concat([...entries, directory, end]),
);
