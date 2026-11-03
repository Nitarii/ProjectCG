'use strict';

const { performance } = require('perf_hooks');

function startFixedLoop({ hz, maxCatchUpSteps = 2, onTick, onMetrics }) {
  const stepMs = 1000 / Math.max(1, hz || 30);
  let nextAt = performance.now() + stepMs;
  let stopped = false;
  let maxLagMs = 0, lagSum = 0, lagSamples = 0, tickCostSum = 0, tickSamples = 0;

  function run() {
    if (stopped) return;
    const now = performance.now();
    const wait = nextAt - now;
    if (wait > 1) return setTimeout(run, Math.max(0, Math.min(stepMs, wait))).unref?.();

    const lag = Math.max(0, now - nextAt);
    maxLagMs = Math.max(maxLagMs, lag); lagSum += lag; lagSamples++;
    let steps = 0;
    while (!stopped && performance.now() >= nextAt && steps < maxCatchUpSteps) {
      const start = performance.now();
      onTick(stepMs / 1000, Date.now());
      tickCostSum += performance.now() - start; tickSamples++;
      nextAt += stepMs; steps++;
    }
    // Après une longue suspension de l'onglet/PC, ne jamais exécuter une rafale de centaines de ticks.
    if (performance.now() - nextAt > stepMs * 4) nextAt = performance.now() + stepMs;
    if (onMetrics && lagSamples >= hz) {
      onMetrics({ avgLagMs:lagSum/lagSamples, maxLagMs, avgTickCostMs:tickCostSum/Math.max(1,tickSamples) });
      maxLagMs=0;lagSum=0;lagSamples=0;tickCostSum=0;tickSamples=0;
    }
    const delay = Math.max(0, Math.min(stepMs, nextAt - performance.now()));
    setTimeout(run, delay).unref?.();
  }
  const timer = setTimeout(run, stepMs); timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { startFixedLoop };
