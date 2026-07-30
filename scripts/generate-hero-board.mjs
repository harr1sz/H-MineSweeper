import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const columns = 11;
const rows = 9;
const cellSize = 86;
const gap = 8;
const boardWidth = columns * (cellSize + gap) + gap;
const boardHeight = rows * (cellSize + gap) + gap;
const viewWidth = 1320;
const viewHeight = 1024;

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(projectRoot, "apps", "web", "public");
const svgPath = join(publicDir, "hero-board-h-v2.svg");
const manifestPath = join(publicDir, "hero-board-h-v2.manifest.json");

const mineCoordinates = new Set();
for (let y = 1; y <= 7; y += 1) {
  mineCoordinates.add(`2,${y}`);
  mineCoordinates.add(`8,${y}`);
}
for (let x = 2; x <= 8; x += 1) {
  mineCoordinates.add(`${x},4`);
}

const expectedMineCount = 19;
if (mineCoordinates.size !== expectedMineCount) {
  throw new Error(
    `H layout must contain ${expectedMineCount} mines; received ${mineCoordinates.size}`,
  );
}

function isMine(x, y) {
  return mineCoordinates.has(`${x},${y}`);
}

function adjacentMineCount(x, y) {
  let count = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) continue;
      const nextX = x + offsetX;
      const nextY = y + offsetY;
      if (
        nextX >= 0 &&
        nextX < columns &&
        nextY >= 0 &&
        nextY < rows &&
        isMine(nextX, nextY)
      ) {
        count += 1;
      }
    }
  }
  return count;
}

const numberColors = [
  "",
  "#70B7FF",
  "#55D5A6",
  "#FF6B70",
  "#B08AFF",
  "#FFB45A",
  "#66E4E9",
  "#F18DDB",
  "#FFFFFF",
];

const cellRecords = [];
const cellMarkup = [];

for (let y = 0; y < rows; y += 1) {
  for (let x = 0; x < columns; x += 1) {
    const index = y * columns + x;
    const mine = isMine(x, y);
    const adjacent = mine ? null : adjacentMineCount(x, y);
    if (adjacent !== null && (adjacent < 0 || adjacent > 8)) {
      throw new Error(`Invalid adjacent count ${adjacent} at ${x},${y}`);
    }
    cellRecords.push({ index, x, y, mine, adjacent });

    const left = gap + x * (cellSize + gap);
    const top = gap + y * (cellSize + gap);
    const centerX = left + cellSize / 2;
    const centerY = top + cellSize / 2;
    const fill = mine ? "url(#mineCell)" : "url(#openCell)";

    cellMarkup.push(`
      <g data-index="${index}" data-mine="${mine}" data-adjacent="${adjacent ?? ""}">
        <rect x="${left}" y="${top}" width="${cellSize}" height="${cellSize}" rx="8"
          fill="${fill}" stroke="${mine ? "#BD8627" : "#38516D"}" stroke-width="${mine ? 3 : 2}"/>
        <path d="M${left + 8} ${top + 7}H${left + cellSize - 8}"
          stroke="${mine ? "#FFE197" : "#A2BED9"}" stroke-opacity="${mine ? "0.68" : "0.24"}"
          stroke-width="2"/>
        ${
          mine
            ? `<g filter="url(#goldGlow)" aria-label="mine marker">
                <g stroke="#F8BD45" stroke-width="7" stroke-linecap="round">
                  <path d="M${centerX} ${centerY - 31}V${centerY - 23}"/>
                  <path d="M${centerX} ${centerY + 23}V${centerY + 31}"/>
                  <path d="M${centerX - 31} ${centerY}H${centerX - 23}"/>
                  <path d="M${centerX + 23} ${centerY}H${centerX + 31}"/>
                  <path d="M${centerX - 22} ${centerY - 22}L${centerX - 16} ${centerY - 16}"/>
                  <path d="M${centerX + 16} ${centerY + 16}L${centerX + 22} ${centerY + 22}"/>
                  <path d="M${centerX + 22} ${centerY - 22}L${centerX + 16} ${centerY - 16}"/>
                  <path d="M${centerX - 16} ${centerY + 16}L${centerX - 22} ${centerY + 22}"/>
                </g>
                <circle cx="${centerX}" cy="${centerY}" r="23"
                  fill="url(#mineCore)" stroke="#FFE08A" stroke-width="4"/>
                <path d="M${centerX - 12} ${centerY - 12}Q${centerX - 3} ${centerY - 20} ${centerX + 7} ${centerY - 14}"
                  fill="none" stroke="#FFF1BD" stroke-width="3" stroke-linecap="round"
                  stroke-opacity="0.82"/>
                <g fill="#E9AB32" stroke="#FFE29A" stroke-width="1">
                  <circle cx="${centerX}" cy="${centerY}" r="4"/>
                  <circle cx="${centerX - 11}" cy="${centerY - 7}" r="3"/>
                  <circle cx="${centerX + 11}" cy="${centerY - 7}" r="3"/>
                  <circle cx="${centerX - 8}" cy="${centerY + 10}" r="3"/>
                  <circle cx="${centerX + 8}" cy="${centerY + 10}" r="3"/>
                </g>
              </g>`
            : adjacent > 0
              ? `<text x="${centerX}" y="${centerY + 3}" text-anchor="middle"
                    dominant-baseline="middle" fill="${numberColors[adjacent]}"
                    font-family="Inter, ui-sans-serif, system-ui, sans-serif"
                    font-size="46" font-weight="900" stroke="#040A11" stroke-width="3"
                    paint-order="stroke fill">${adjacent}</text>`
              : `<rect x="${centerX - 4}" y="${centerY - 4}" width="8" height="8" rx="2"
                    fill="#9CB2C8" fill-opacity="0.16"/>`
        }
      </g>`);
  }
}

const manifest = {
  version: 2,
  asset: "hero-board-h-v2.svg",
  rules: {
    neighborhood: "8-neighbor",
    mineShape: "H",
    minePresentation: "large gold mine markers",
    numbers: "exact adjacent mine counts; mines never display a number",
  },
  board: {
    width: columns,
    height: rows,
    mines: expectedMineCount,
  },
  mineCoordinates: [...mineCoordinates]
    .map((coordinate) => coordinate.split(",").map(Number))
    .map(([x, y]) => ({ x, y, index: y * columns + x }))
    .sort((left, right) => left.index - right.index),
  cells: cellRecords,
};

const leftH = gap + 2 * (cellSize + gap) + cellSize / 2;
const rightH = gap + 8 * (cellSize + gap) + cellSize / 2;
const topH = gap + 1 * (cellSize + gap) + cellSize / 2;
const middleH = gap + 4 * (cellSize + gap) + cellSize / 2;
const bottomH = gap + 7 * (cellSize + gap) + cellSize / 2;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}" height="${viewHeight}"
  viewBox="0 0 ${viewWidth} ${viewHeight}" role="img"
  aria-labelledby="board-title board-description">
  <title id="board-title">H-MineSweeper high-legibility verified H board</title>
  <desc id="board-description">A deterministic Minesweeper board whose nineteen large gold mine markers form the letter H. Every visible number equals its adjacent mine count.</desc>
  <defs>
    <linearGradient id="boardMetal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#34475B"/>
      <stop offset="0.34" stop-color="#142334"/>
      <stop offset="1" stop-color="#070D14"/>
    </linearGradient>
    <linearGradient id="openCell" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#21364B"/>
      <stop offset="0.52" stop-color="#182A3C"/>
      <stop offset="1" stop-color="#101C29"/>
    </linearGradient>
    <linearGradient id="mineCell" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#39280D"/>
      <stop offset="0.56" stop-color="#261A09"/>
      <stop offset="1" stop-color="#120E08"/>
    </linearGradient>
    <radialGradient id="mineCore" cx="34%" cy="28%" r="78%">
      <stop offset="0" stop-color="#526170"/>
      <stop offset="0.22" stop-color="#283541"/>
      <stop offset="0.7" stop-color="#111820"/>
      <stop offset="1" stop-color="#05080C"/>
    </radialGradient>
    <linearGradient id="rimGold" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#725B31"/>
      <stop offset="0.38" stop-color="#F0CE87"/>
      <stop offset="1" stop-color="#50657A"/>
    </linearGradient>
    <filter id="boardShadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="34" stdDeviation="28" flood-color="#000713" flood-opacity="0.82"/>
      <feDropShadow dx="-6" dy="-4" stdDeviation="12" flood-color="#5689C7" flood-opacity="0.16"/>
    </filter>
    <filter id="goldGlow" x="-80%" y="-80%" width="260%" height="260%">
      <feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#F2B63D" flood-opacity="0.48"/>
    </filter>
  </defs>
  <g transform="translate(145 78) rotate(9 ${boardWidth / 2} ${boardHeight / 2}) skewX(-3)"
    filter="url(#boardShadow)">
    <rect x="-18" y="-18" width="${boardWidth + 36}" height="${boardHeight + 36}" rx="20"
      fill="url(#boardMetal)" stroke="url(#rimGold)" stroke-width="6"/>
    <rect x="-7" y="-7" width="${boardWidth + 14}" height="${boardHeight + 14}" rx="14"
      fill="#07101A" stroke="#6685A5" stroke-opacity="0.62" stroke-width="2"/>
    <path d="M${leftH} ${topH}V${bottomH} M${rightH} ${topH}V${bottomH} M${leftH} ${middleH}H${rightH}"
      fill="none" stroke="#E4B85B" stroke-opacity="0.18" stroke-width="20"
      stroke-linecap="round" filter="url(#goldGlow)"/>
    ${cellMarkup.join("")}
    <path d="M18 1H${boardWidth - 18}" stroke="#FFE4A0" stroke-opacity="0.58" stroke-width="3"/>
  </g>
</svg>
`;

await mkdir(publicDir, { recursive: true });
await writeFile(svgPath, svg.replace(/[ \t]+$/gm, ""), "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify({
    svgPath,
    manifestPath,
    width: columns,
    height: rows,
    mines: mineCoordinates.size,
    verifiedSafeCells: cellRecords.filter((cell) => !cell.mine).length,
  }),
);
