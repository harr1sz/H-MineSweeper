import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const columns = 11;
const rows = 9;
const cellSize = 80;
const gap = 7;
const boardWidth = columns * (cellSize + gap) + gap;
const boardHeight = rows * (cellSize + gap) + gap;
const viewWidth = 1320;
const viewHeight = 1024;

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(projectRoot, "apps", "web", "public");

const variants = [
  {
    id: "solo",
    asset: "hero-solo-verified-v1.svg",
    manifest: "hero-solo-verified-v1.manifest.json",
    title: "Verified solo training board",
    description:
      "A deterministic solo training board. Every visible number equals its adjacent mine count.",
    accent: "#E4B85B",
    rotation: 8,
    translateX: 138,
    translateY: 92,
    mines: [
      [2, 1], [5, 1], [8, 1], [3, 2], [7, 2],
      [9, 3], [1, 4], [5, 4], [8, 4], [3, 5],
      [6, 5], [9, 6], [2, 7], [5, 7], [8, 7],
    ],
    overlay: `<path d="M55 702C230 620 355 662 505 548C632 451 735 471 892 328"
      fill="none" stroke="#E4B85B" stroke-opacity="0.2" stroke-width="12"
      stroke-linecap="round" stroke-dasharray="2 26"/>`,
  },
];

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

function generateVariant(variant) {
  const mineCoordinates = new Set(
    variant.mines.map(([x, y]) => `${x},${y}`),
  );

  if (mineCoordinates.size !== variant.mines.length) {
    throw new Error(`${variant.id} contains duplicate mine coordinates`);
  }

  const isMine = (x, y) => mineCoordinates.has(`${x},${y}`);
  const adjacentMineCount = (x, y) => {
    let count = 0;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;
        if (isMine(x + offsetX, y + offsetY)) count += 1;
      }
    }
    return count;
  };

  const cells = [];
  const cellMarkup = [];

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const index = y * columns + x;
      const mine = isMine(x, y);
      const adjacent = mine ? null : adjacentMineCount(x, y);
      const left = gap + x * (cellSize + gap);
      const top = gap + y * (cellSize + gap);
      const centerX = left + cellSize / 2;
      const centerY = top + cellSize / 2;

      cells.push({ index, x, y, mine, adjacent });
      cellMarkup.push(`<g data-index="${index}" data-mine="${mine}" data-adjacent="${adjacent ?? ""}">
        <rect x="${left}" y="${top}" width="${cellSize}" height="${cellSize}" rx="8"
          fill="${mine ? "url(#mineCell)" : "url(#openCell)"}"
          stroke="${mine ? "#BD8627" : "#38516D"}" stroke-width="${mine ? 3 : 2}"/>
        <path d="M${left + 8} ${top + 7}H${left + cellSize - 8}"
          stroke="${mine ? "#FFE197" : "#A2BED9"}"
          stroke-opacity="${mine ? "0.68" : "0.24"}" stroke-width="2"/>
        ${mine ? mineMarker(centerX, centerY) : safeCell(centerX, centerY, adjacent)}
      </g>`);
    }
  }

  const manifest = {
    version: 1,
    asset: variant.asset,
    mode: variant.id,
    rules: {
      neighborhood: "8-neighbor",
      minePresentation: "large gold mine markers",
      numbers: "exact adjacent mine counts; mines never display a number",
    },
    board: { width: columns, height: rows, mines: mineCoordinates.size },
    mineCoordinates: variant.mines
      .map(([x, y]) => ({ x, y, index: y * columns + x }))
      .sort((left, right) => left.index - right.index),
    cells,
  };

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}" height="${viewHeight}"
    viewBox="0 0 ${viewWidth} ${viewHeight}" role="img"
    aria-labelledby="board-title board-description">
    <title id="board-title">${variant.title}</title>
    <desc id="board-description">${variant.description}</desc>
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
        <stop offset="0.7" stop-color="#111820"/>
        <stop offset="1" stop-color="#05080C"/>
      </radialGradient>
      <filter id="boardShadow" x="-30%" y="-30%" width="160%" height="170%">
        <feDropShadow dx="0" dy="34" stdDeviation="28" flood-color="#000713" flood-opacity="0.82"/>
        <feDropShadow dx="-6" dy="-4" stdDeviation="12" flood-color="${variant.accent}" flood-opacity="0.14"/>
      </filter>
      <filter id="goldGlow" x="-80%" y="-80%" width="260%" height="260%">
        <feDropShadow dx="0" dy="0" stdDeviation="7" flood-color="#F2B63D" flood-opacity="0.48"/>
      </filter>
    </defs>
    <g transform="translate(${variant.translateX} ${variant.translateY}) rotate(${variant.rotation} ${boardWidth / 2} ${boardHeight / 2})"
      filter="url(#boardShadow)">
      <rect x="-18" y="-18" width="${boardWidth + 36}" height="${boardHeight + 36}" rx="20"
        fill="url(#boardMetal)" stroke="${variant.accent}" stroke-opacity="0.72" stroke-width="5"/>
      <rect x="-7" y="-7" width="${boardWidth + 14}" height="${boardHeight + 14}" rx="14"
        fill="#07101A" stroke="#6685A5" stroke-opacity="0.62" stroke-width="2"/>
      ${cellMarkup.join("\n")}
      ${variant.overlay}
      <path d="M18 1H${boardWidth - 18}" stroke="#FFE4A0" stroke-opacity="0.5" stroke-width="3"/>
    </g>
  </svg>\n`;

  return { manifest, svg };
}

function safeCell(centerX, centerY, adjacent) {
  if (adjacent === 0) {
    return `<rect x="${centerX - 4}" y="${centerY - 4}" width="8" height="8" rx="2"
      fill="#9CB2C8" fill-opacity="0.16"/>`;
  }
  return `<text x="${centerX}" y="${centerY + 3}" text-anchor="middle"
    dominant-baseline="middle" fill="${numberColors[adjacent]}"
    font-family="Inter, ui-sans-serif, system-ui, sans-serif"
    font-size="43" font-weight="900" stroke="#040A11" stroke-width="3"
    paint-order="stroke fill">${adjacent}</text>`;
}

function mineMarker(centerX, centerY) {
  return `<g filter="url(#goldGlow)" aria-label="mine marker">
    <g stroke="#F8BD45" stroke-width="6" stroke-linecap="round">
      <path d="M${centerX} ${centerY - 28}V${centerY - 21}"/>
      <path d="M${centerX} ${centerY + 21}V${centerY + 28}"/>
      <path d="M${centerX - 28} ${centerY}H${centerX - 21}"/>
      <path d="M${centerX + 21} ${centerY}H${centerX + 28}"/>
      <path d="M${centerX - 20} ${centerY - 20}L${centerX - 15} ${centerY - 15}"/>
      <path d="M${centerX + 15} ${centerY + 15}L${centerX + 20} ${centerY + 20}"/>
      <path d="M${centerX + 20} ${centerY - 20}L${centerX + 15} ${centerY - 15}"/>
      <path d="M${centerX - 15} ${centerY + 15}L${centerX - 20} ${centerY + 20}"/>
    </g>
    <circle cx="${centerX}" cy="${centerY}" r="21"
      fill="url(#mineCore)" stroke="#FFE08A" stroke-width="4"/>
    <g fill="#E9AB32" stroke="#FFE29A" stroke-width="1">
      <circle cx="${centerX}" cy="${centerY}" r="4"/>
      <circle cx="${centerX - 10}" cy="${centerY - 7}" r="3"/>
      <circle cx="${centerX + 10}" cy="${centerY - 7}" r="3"/>
      <circle cx="${centerX - 7}" cy="${centerY + 9}" r="3"/>
      <circle cx="${centerX + 7}" cy="${centerY + 9}" r="3"/>
    </g>
  </g>`;
}

await mkdir(publicDir, { recursive: true });
for (const variant of variants) {
  const { manifest, svg } = generateVariant(variant);
  await writeFile(join(publicDir, variant.asset), svg, "utf8");
  await writeFile(
    join(publicDir, variant.manifest),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

console.log(
  JSON.stringify(
    variants.map((variant) => ({
      asset: variant.asset,
      mines: variant.mines.length,
      verifiedCells: columns * rows,
    })),
  ),
);
