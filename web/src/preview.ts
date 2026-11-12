/** This flag is always false and removed from production bundles. */
export const isUiPreview = import.meta.env.DEV && import.meta.env.MODE === 'ui-preview';
