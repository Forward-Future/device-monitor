// Estimated electricity use ("at the wall") per device.
//
// Agents report whatever the hardware measures: NVIDIA GPU power (nvidia-smi), CPU power where a
// sensor exists (LibreHardwareMonitor on Windows, RAPL or NVIDIA Grace power meters on Linux),
// AMD GPU power on Linux. Everything else is estimated:
//  - an unmeasured CPU, from its load and a rough power range for its size
//  - an unmeasured discrete GPU, from its load
//  - the rest of the system (motherboard, RAM, drives, fans), a fixed allowance
//  - power-supply / charger losses
// so totals are estimates, usually within ~20% of a plug-in power meter.

function profile(hw = {}) {
  const laptop = hw.formFactor === 'laptop';
  const threads = Math.max(1, Math.min(512, hw.threads || 8));
  return {
    laptop,
    cpuIdle: laptop ? 3 : 12,
    cpuMax: laptop ? Math.min(45, 8 + threads * 2) : Math.min(250, 30 + threads * 5),
    rest: laptop ? 6 : 25,
    efficiency: laptop ? 0.88 : 0.9,
  };
}

const cpuEstimate = (usage, p) => p.cpuIdle + (p.cpuMax - p.cpuIdle) * Math.max(0, Math.min(100, usage)) / 100;

// Discrete GPUs without a power reading (AMD/Intel on Windows). Small adapters are assumed to be
// integrated graphics, whose power is already part of the CPU package.
const gpuEstimate = g => (g.memTotal || 0) >= 2 * 2 ** 30 ? 10 + 1.5 * (g.usage || 0) : 0;

// From a full report: total watts plus the breakdown shown in the dashboard.
function estimate(report) {
  const p = profile({ formFactor: report.formFactor, threads: report.cpu?.threads });
  const measuredCpu = report.power?.cpu;
  const cpu = measuredCpu ?? (report.cpu?.usage != null ? cpuEstimate(report.cpu.usage, p) : null);
  if (cpu == null) return null;
  let gpu = 0, gpuMeasured = false, gpuEstimated = false;
  for (const g of report.gpus || []) {
    if (g.power != null) { gpu += g.power; gpuMeasured = true; }
    else { const e = gpuEstimate(g); if (e) { gpu += e; gpuEstimated = true; } }
  }
  const components = cpu + gpu + p.rest;
  const watts = components / p.efficiency;
  const r1 = v => Math.round(v * 10) / 10;
  return {
    watts: r1(watts), cpu: r1(cpu), gpu: r1(gpu), rest: p.rest, losses: r1(watts - components),
    cpuMeasured: measuredCpu != null, gpuMeasured, gpuEstimated,
  };
}

// From a stored history point that has no `power` (recorded before power was tracked).
function fromSample(s, hw) {
  if (s.cpu == null) return null;
  const p = profile(hw);
  return (cpuEstimate(s.cpu, p) + (s.gpuPower || 0) + p.rest) / p.efficiency;
}

module.exports = { estimate, fromSample, profile };
