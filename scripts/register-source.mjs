import { registerHooks } from 'node:module';
import { resolve } from './source-resolver.mjs';

registerHooks({ resolve });
