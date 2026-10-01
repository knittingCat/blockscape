// Block catalogue. ids are stored in saved scenes, so never renumber or reuse them.
// tex: one texture name for all faces, or { top, side, bottom }.
export const BLOCKS = [
  { id: 1, name: 'Grass', tex: { top: 'grassTop', side: 'grassSide', bottom: 'dirt' } },
  { id: 2, name: 'Dirt', tex: 'dirt' },
  { id: 3, name: 'Stone', tex: 'stone' },
  { id: 4, name: 'Cobblestone', tex: 'cobble' },
  { id: 5, name: 'Sand', tex: 'sand' },
  { id: 6, name: 'Sandstone', tex: 'sandstone' },
  { id: 7, name: 'Snow', tex: 'snow' },
  { id: 8, name: 'Ice', tex: 'ice', alpha: 0.75 },
  { id: 9, name: 'Water', tex: 'water', alpha: 0.65 },
  { id: 10, name: 'Lava', tex: 'lava', glow: 0.9 },
  { id: 11, name: 'Log', tex: { top: 'logTop', side: 'logSide', bottom: 'logTop' } },
  { id: 12, name: 'Planks', tex: 'planks' },
  { id: 13, name: 'Leaves', tex: 'leaves' },
  { id: 14, name: 'Bricks', tex: 'brick' },
  { id: 15, name: 'Glass', tex: 'glass', alpha: 0.4 },
  { id: 16, name: 'Glowstone', tex: 'glowstone', glow: 0.8 },
  { id: 17, name: 'Gold', tex: 'gold' },
  { id: 18, name: 'Obsidian', tex: 'obsidian' },
  { id: 19, name: 'White wool', tex: 'wool:236,236,236' },
  { id: 20, name: 'Red wool', tex: 'wool:176,46,38' },
  { id: 21, name: 'Orange wool', tex: 'wool:240,118,19' },
  { id: 22, name: 'Yellow wool', tex: 'wool:249,198,40' },
  { id: 23, name: 'Green wool', tex: 'wool:94,124,22' },
  { id: 24, name: 'Blue wool', tex: 'wool:60,68,170' },
  { id: 25, name: 'Purple wool', tex: 'wool:137,50,184' },
  { id: 26, name: 'Pink wool', tex: 'wool:237,141,172' },
  { id: 27, name: 'Brown wool', tex: 'wool:114,71,40' },
  { id: 28, name: 'Black wool', tex: 'wool:29,29,33' },
];

export const BLOCK_BY_ID = new Map(BLOCKS.map((b) => [b.id, b]));
