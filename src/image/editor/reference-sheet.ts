const SHEET_HEIGHT = 768;
const MAX_TILE_WIDTH = 768;

function load(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("A character reference could not be loaded for the reference sheet."));
    image.src = url;
  });
}

/** Combine character views into one reference image. Qwen 2.1 treats several
 * reference images as panels on some scenes; a single sheet keeps the scene
 * request as one image while preserving all three identity views. */
export async function referenceSheetCanvas(urls: string[]) {
  if (urls.length < 2) throw new Error("A reference sheet needs at least two views.");
  const images = await Promise.all(urls.map(load));
  const tiles = images.map(image => {
    const scale = Math.min(SHEET_HEIGHT / image.naturalHeight, MAX_TILE_WIDTH / image.naturalWidth);
    return {
      image,
      width: Math.max(1, Math.round(image.naturalWidth * scale)),
      height: Math.max(1, Math.round(image.naturalHeight * scale)),
    };
  });
  const canvas = document.createElement("canvas");
  canvas.width = tiles.reduce((total, tile) => total + tile.width, 0);
  canvas.height = Math.max(...tiles.map(tile => tile.height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The reference sheet could not be created.");
  context.fillStyle = "#e9e9e9";
  context.fillRect(0, 0, canvas.width, canvas.height);
  let x = 0;
  for (const tile of tiles) {
    context.drawImage(tile.image, x, 0, tile.width, tile.height);
    x += tile.width;
  }
  return canvas;
}
