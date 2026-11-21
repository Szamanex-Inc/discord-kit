import type { FeatureName } from '@discord-kit/config';
import type { Feature } from '../feature.ts';
import { applications } from './applications.ts';
import { events } from './events.ts';
import { github } from './github/index.ts';
import { projects } from './projects/index.ts';
import { rolePicker } from './role-picker.ts';
import { welcome } from './welcome.ts';

/** Module registry. The type requires a module for every name in FEATURES from @discord-kit/config. */
export const features: Record<FeatureName, Feature> = {
  role_picker: rolePicker,
  welcome,
  applications,
  events,
  github,
  projects,
};
