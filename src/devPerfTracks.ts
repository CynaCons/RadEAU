/**
 * Dev-only: React's development build streams one user-timing entry per
 * component render into the Performance panel's "Components ⚛" track. Under a
 * live trace that is tens of thousands of `performance.measure` calls per
 * second — about half the UI thread on its own, which makes the Vite build
 * unrepresentative (dissection panels took 10+ s to resolve). React gates the
 * feature on `console.timeStamp` existing at module evaluation, so this must
 * be the first import of the entry module. Production React never emits them.
 */
if (import.meta.env.DEV) {
  (console as { timeStamp?: unknown }).timeStamp = undefined;
}

export {};
