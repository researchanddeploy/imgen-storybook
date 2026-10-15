import sharp from "sharp";
import { createMemoryStorage, createMockImageProvider, createStoryEngine, type StoryEngineOptions } from "../src/index.js";

export async function png(color = { r: 255, g: 0, b: 0 }, size = 8): Promise<Buffer> {
    return sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
}

export function setup(overrides: Partial<StoryEngineOptions> = {}) {
    const provider = createMockImageProvider();
    const storage = createMemoryStorage();
    const engine = createStoryEngine({ storage, provider, ...overrides });
    return { engine, provider, storage };
}
