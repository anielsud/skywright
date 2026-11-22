// Paints the aircraft skin's detail texture off the main thread (skinTexture.js) and sends the pixels back.
import { paintSkinDetail, SKIN_TEX_SIZE } from './skinTexture.js';

const img = paintSkinDetail(() => new OffscreenCanvas(SKIN_TEX_SIZE, SKIN_TEX_SIZE));
postMessage(img.data.buffer, [img.data.buffer]);
