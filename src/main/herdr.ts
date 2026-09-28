import { MockHerdr } from './mock.ts';
import type { HandsConfig } from './config.ts';
export class HerdrClient extends MockHerdr { constructor(_cfg: HandsConfig) { super(); } }
