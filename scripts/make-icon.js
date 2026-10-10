// Draws media/icon.png (the Marketplace / extensions-list icon): a glass cube with an eye.
// Pure Node, no image libraries: each pixel is shaded from distances to the shapes.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const px = new Uint8Array(SIZE * SIZE * 4);

// The cube: a hexagon outline plus the three inner edges, in a 0..1 coordinate space.
const c = { x: 0.5, y: 0.5 };
const r = 0.3;
const hex = [...Array(6)].map((_, i) => {
	const a = (Math.PI / 3) * i - Math.PI / 2;
	return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
});
const edges = hex.map((p, i) => [p, hex[(i + 1) % 6]]);
const inner = [
	[c, hex[0]],
	[c, hex[2]],
	[c, hex[4]],
];

function segDist(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function roundedBoxDist(p, half, radius) {
	const qx = Math.abs(p.x - 0.5) - half + radius;
	const qy = Math.abs(p.y - 0.5) - half + radius;
	return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Blends `color` with coverage `alpha` (0..1) onto the pixel.
function blend(i, color, alpha) {
	for (let k = 0; k < 3; k++) {
		px[i + k] = Math.round(px[i + k] * (1 - alpha) + color[k] * alpha);
	}
	px[i + 3] = Math.max(px[i + 3], Math.round(alpha * 255));
}

const aa = 1.2 / SIZE;
const cover = (d, width) => Math.max(0, Math.min(1, (width - d) / aa + 0.5));

for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		const i = (y * SIZE + x) * 4;
		const p = { x: (x + 0.5) / SIZE, y: (y + 0.5) / SIZE };

		// Background: rounded square, dark blue gradient.
		const bg = cover(roundedBoxDist(p, 0.47, 0.12), 0);
		if (bg <= 0) {
			continue;
		}
		const t = p.y;
		blend(i, [Math.round(10 + 8 * t), Math.round(25 + 30 * t), Math.round(55 + 50 * t)], bg);

		// Glass faces: faint fill inside the hexagon.
		const inside = edges.every(([a, b]) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0);
		if (inside) {
			blend(i, [120, 200, 255], 0.1 * bg);
		}

		// Cube outline (bright) and inner edges (softer).
		const outline = Math.min(...edges.map(([a, b]) => segDist(p, a, b)));
		blend(i, [126, 224, 255], cover(outline, 0.016) * bg);
		const innerEdge = Math.min(...inner.map(([a, b]) => segDist(p, a, b)));
		blend(i, [126, 224, 255], 0.45 * cover(innerEdge, 0.009) * bg);

		// The eye: an almond shape with a green pupil, in front of the cube.
		const ex = (p.x - 0.5) / 0.2;
		const ey = (p.y - 0.62) / 0.1;
		const almond = Math.abs(ey) - (1 - ex * ex);
		if (Math.abs(ex) <= 1 && almond <= 0) {
			blend(i, [13, 17, 23], 0.92 * bg);
		}
		const lid = Math.abs(ex) <= 1 ? Math.abs(Math.abs(ey) - (1 - ex * ex)) * 0.1 : 1;
		blend(i, [230, 237, 243], cover(lid, 0.008) * bg);
		const pupil = Math.hypot(p.x - 0.5, p.y - 0.62);
		blend(i, [63, 185, 80], cover(pupil, 0.05) * bg);
		blend(i, [230, 255, 235], cover(Math.hypot(p.x - 0.515, p.y - 0.605), 0.012) * bg);
	}
}

// Minimal PNG encoder: RGBA, no interlace.
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
	let crc = -1;
	for (const byte of buf) {
		crc ^= byte;
		for (let k = 0; k < 8; k++) {
			crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
		}
	}
	return crc ^ -1;
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // RGBA
const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
	rows[y * (SIZE * 4 + 1)] = 0;
	Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(rows, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	chunk('IHDR', header),
	chunk('IDAT', zlib.deflateSync(rows)),
	chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
