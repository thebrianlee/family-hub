import pkg from "../../package.json";

import { LATEST_SCHEMA } from "./migrations";

/** The app version (package.json is the single source) and the schema it writes. */
export const APP_VERSION: string = pkg.version;
export const SCHEMA_VERSION: number = LATEST_SCHEMA;
