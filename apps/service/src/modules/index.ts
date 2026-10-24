// Static module list (no dynamic import: the service is bundled into one file). Order = start order.
import type { ServiceModule } from './types.js';
import { health } from './health.js';
import { settingsModule } from './settings.js';
import { licenseModule } from './license.js';
import { hardwareModule } from './hardware.js';
import { providersModule } from './providers.js';
import { usageModule } from './usage.js';
import { projectsModule } from './projects.js';
import { compositionModule } from './composition.js';
import { assetsModule } from './assets.js';
import { mediaModule } from './media.js';
import { catalogueModule } from './catalogue.js';
import { intentsModule } from './intents.js';
import { agentsModule } from './agents.js';
import { rendersModule } from './renders.js';
import { generatorsModule } from './generators.js';
import { modelsModule } from './models.js';
import { diagnosticsModule } from './diagnostics.js';
import { eventsModule } from './events.js';

export const MODULES: readonly ServiceModule[] = [
  health, settingsModule, licenseModule, hardwareModule, providersModule, usageModule, projectsModule, compositionModule, assetsModule, mediaModule,
  catalogueModule, intentsModule, agentsModule, rendersModule, generatorsModule, modelsModule, diagnosticsModule, eventsModule,
];
