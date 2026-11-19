import { execFile } from 'node:child_process';
import { availableParallelism, loadavg } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
let pressureSample;
let sampleAt = 0;

export function capacityDelay(pressure, loadPerCpu) {
  if (![1, 2].includes(pressure) || !Number.isFinite(loadPerCpu) || loadPerCpu >= 0.9) return null;
  return pressure === 1 && loadPerCpu < 0.5 ? 1000 : 5000;
}

async function readGate() {
  const gate = await fetch('http://127.0.0.1:3310/maintenance', { signal: AbortSignal.timeout(2000) });
  if (!gate.ok) throw new Error('Kidsplorers gate unavailable');
  return gate.json();
}

export async function gateOpen(inFlight, read = readGate, wait = sleep) {
  let gate = await read();
  // The five-second QA claim poll briefly registers as work even on an empty
  // queue. Never start during a claim. Confirm it once before cancelling work
  // already running, so a transient empty claim doesn't discard inference.
  if (inFlight && gate.paused === false && gate.active === 1 && gate.activeJobs?.['submission-qa'] === 1) {
    await wait(750);
    gate = await read();
  }
  return gate.paused === false && gate.active === 0;
}

export async function summaryCapacity(inFlight = false) {
  if (!await gateOpen(inFlight)) return null;
  if (!pressureSample || Date.now() - sampleAt >= 3000) {
    sampleAt = Date.now();
    pressureSample = exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 1500 })
      .then(({ stdout }) => Number(stdout.trim()), () => 0);
  }
  return capacityDelay(await pressureSample, loadavg()[0] / availableParallelism());
}

// Cancel only Tab1's HTTP request if another workload needs the shared runner.
export async function withSummaryCapacity(work, capacity = summaryCapacity, interval = 1500) {
  if ((await capacity()) == null) throw new Error('Mini busy');
  const controller = new AbortController();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      if ((await capacity(true)) == null) controller.abort(new Error('Mini busy'));
    } catch { controller.abort(new Error('Mini capacity unavailable')); }
    finally { checking = false; }
  }, interval);
  timer.unref();
  try {
    return await work(AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]));
  } finally { clearInterval(timer); }
}
