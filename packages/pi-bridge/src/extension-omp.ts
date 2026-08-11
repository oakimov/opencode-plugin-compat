/** OMP's manifest-selected entrypoint avoids ambiguous dev-checkout package probes. */
process.env.PI_BRIDGE_HOST ??= "omp"

export { default } from "./extension.js"
