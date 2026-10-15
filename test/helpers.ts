import sharp from "sharp";
import {
    createMemoryStorage,
    createMockImageProvider,
    createStoryEngine,
    type MockProviderOptions,
    type Render,
    type StoryEngine,
    type StoryEngineOptions,
} from "../src/index.js";

export async function png(color = { r: 255, g: 0, b: 0 }, width = 8, height = width): Promise<Buffer> {
    return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

export function setup(overrides: Partial<StoryEngineOptions> = {}, mock: MockProviderOptions = {}) {
    const provider = createMockImageProvider(mock);
    const storage = createMemoryStorage();
    const engine = createStoryEngine({ storage, provider, ...overrides });
    return { engine, provider, storage };
}

/** Submits and drives renders to completion through the mock queue. */
export async function settle(engine: StoryEngine, renders: Render[] | Promise<Render[]>): Promise<Render[]> {
    const list = await renders;
    return Promise.all(list.map((r) => engine.waitForRender(r.id, { pollIntervalMs: 1, timeoutMs: 5000 })));
}
