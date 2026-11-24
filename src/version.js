// Build info. VERSION is bumped by hand; COMMIT and BUILT are stamped by the deploy workflow
// (.github/workflows/deploy.yml). Local checkouts show "dev".
export const VERSION = '1.165.0';
export const COMMIT = 'dev';
export const BUILT = '';
// a hash of the crew posture solver (src/crew.js, src/body.js, assets/people/): solved postures stay valid until it changes
export const SOLVER = 'dev';
// a hash of the cabin lighting bake (src/cabinLight.js, src/interior.js): saved bakes stay valid until it changes
export const LIGHT = 'dev';
// a hash of the cockpit views' code (src/stations.js): which linings cover the windows, saved and baked, stays valid until it changes
export const VIEWS = 'dev';
