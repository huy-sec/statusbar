// CPU, RAM, temperature, GPU, and the Janas process's own CPU/memory.
// NVIDIA cards are read with nvidia-smi (with temperature and power). Any other card
// (AMD, Intel) falls back to Windows' own GPU counters, the ones Task Manager shows:
// load and VRAM, without temperature. Nothing here needs admin rights.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// nvidia-smi is normally on the PATH, but not always.
const NVIDIA_SMI = [
  'nvidia-smi',
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
];

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount
# The graphics card with the most dedicated memory (the discrete one, if there is one).
$card = Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' |
  Where-Object { $_.PSChildName -match '^\\d{4}$' } |
  ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    # Drivers record the memory size in different places (AMD often only the older one).
    $m = [int64]$p.'HardwareInformation.qwMemorySize'
    if ($m -le 0) {
      $v = $p.'HardwareInformation.MemorySize'
      if ($v -is [byte[]] -and $v.Length -ge 4) { $m = [int64][BitConverter]::ToUInt32($v, 0) } elseif ($v) { $m = [int64]$v }
    }
    [pscustomobject]@{ name = $p.DriverDesc; mem = $m }
  } | Sort-Object mem -Descending | Select-Object -First 1
if ($card -and $card.mem -le 0) {
  $vc = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -eq $card.name } | Select-Object -First 1
  if ($vc.AdapterRAM -gt 0) { $card.mem = [int64]$vc.AdapterRAM }  # capped at 4 GB by Windows
}
function Get-Gpu {
  if (-not $card) { return $null }
  # The main card is the adapter using the most dedicated memory; a built-in chip uses little.
  $mem = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory
  $main = $mem | Sort-Object DedicatedUsage -Descending | Select-Object -First 1
  $luid = if ($main -and $main.Name -match '^(luid_0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)') { $matches[1] } else { $null }
  # Load: that card's busiest engine type, summed over processes, like Task Manager.
  $eng = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine
  if ($luid) { $eng = $eng | Where-Object { $_.Name -like "*$luid*" } }
  $util = $null
  if ($eng) {
    $util = ($eng | Group-Object { if ($_.Name -match 'engtype_(.+)$') { $matches[1] } else { 'x' } } |
      ForEach-Object { ($_.Group | Measure-Object UtilizationPercentage -Sum).Sum } |
      Measure-Object -Maximum).Maximum
    if ($util -gt 100) { $util = 100 }
  }
  $used = if ($main) { $main.DedicatedUsage } else { $null }
  @{ name = $card.name; util = $util; memUsed = if ($used -ne $null) { [math]::Round($used / 1MB) } else { $null };
     memTotal = if ($card.mem -gt 0) { [math]::Round($card.mem / 1MB) } else { $null } }
}
while ($true) {
  $tz = Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation |
        ForEach-Object { if ($_.HighPrecisionTemperature) { $_.HighPrecisionTemperature / 10 - 273.15 } else { $_.Temperature - 273.15 } }
  $temp = if ($tz) { [math]::Round(($tz | Measure-Object -Maximum).Maximum, 1) } else { $null }
  $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name='janas-server'"
  $j = $null
  if ($p) { $p = @($p)[0]; $j = @{ cpu = [math]::Round($p.PercentProcessorTime / $cores, 1); mem = [int64]$p.WorkingSetPrivate } }
  @{ temp = $temp; janas = $j; gpu = (Get-Gpu) } | ConvertTo-Json -Compress
  Start-Sleep -Seconds 3
}`;

class HardwareCollector extends EventEmitter {
  constructor() {
    super();
    this.state = { cpu: null, ramUsed: null, ramTotal: os.totalmem(), temp: null, gpu: null, janasProc: null };
    this.prev = null;
    this.children = [];
    this.stopped = false;
  }

  start() {
    this.cpuTimer = setInterval(() => this.sampleCpu(), 2000);
    this.sampleCpu();
    this.startNvidia();
    this.startPowerShell();
  }

  sampleCpu() {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const c of cpus) {
      for (const v of Object.values(c.times)) total += v;
      idle += c.times.idle;
    }
    if (this.prev) {
      const dt = total - this.prev.total;
      const di = idle - this.prev.idle;
      this.state.cpu = dt > 0 ? Math.max(0, Math.min(100, 100 * (1 - di / dt))) : 0;
    }
    this.prev = { idle, total };
    this.state.ramTotal = os.totalmem();
    this.state.ramUsed = os.totalmem() - os.freemem();
    this.emit('update');
  }

  lines(child, onLine) {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
  }

  respawn(fn, delay) {
    if (!this.stopped) setTimeout(() => !this.stopped && fn.call(this), delay);
  }

  startNvidia(attempt = 0) {
    // Try each place nvidia-smi may live; with none, the Windows counters take over.
    const exe = NVIDIA_SMI.find((p, i) => i >= attempt && (p === 'nvidia-smi' || fs.existsSync(p)));
    if (!exe) { this.respawn(() => this.startNvidia(0), 60000); return; }
    const next = NVIDIA_SMI.indexOf(exe) + 1;
    const child = spawn(exe, [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits', '-lms', '2000',
    ], { windowsHide: true });
    this.children.push(child);
    let gotData = false;
    child.on('error', () => {});
    child.on('exit', () => this.respawn(() => this.startNvidia(gotData ? 0 : next), gotData ? 15000 : 500));
    this.lines(child, (line) => {
      const [name, util, memUsed, memTotal, temp, power] = line.split(',').map((s) => s.trim());
      const num = (s) => (s === undefined || isNaN(Number(s)) ? null : Number(s));
      if (num(memTotal) == null) return; // not a data line (an error message)
      gotData = true;
      this.nvidiaAt = Date.now();
      this.state.gpu = {
        name: name.replace(/^NVIDIA (GeForce )?/, ''),
        util: num(util), memUsed: num(memUsed), memTotal: num(memTotal),
        temp: num(temp), power: num(power),
      };
      this.emit('update');
    });
  }

  // Windows' counters, used when nvidia-smi has given nothing for a while.
  useWindowsGpu(g) {
    if (this.nvidiaAt && Date.now() - this.nvidiaAt < 10000) return;
    if (!g || (g.memTotal == null && g.util == null)) { this.state.gpu = null; return; }
    this.state.gpu = {
      name: String(g.name || 'GPU').replace(/^(NVIDIA (GeForce )?|AMD (Radeon\(TM\) )?|Intel\(R\) )/, ''),
      util: g.util ?? null, memUsed: g.memUsed ?? null, memTotal: g.memTotal ?? null,
      temp: null, power: null,
    };
  }

  startPowerShell() {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT], { windowsHide: true });
    this.children.push(child);
    child.on('exit', () => this.respawn(this.startPowerShell, 10000));
    this.lines(child, (line) => {
      try {
        const d = JSON.parse(line);
        this.state.temp = d.temp ?? null;
        this.state.janasProc = d.janas ?? null;
        this.useWindowsGpu(d.gpu);
        this.emit('update');
      } catch {}
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.cpuTimer);
    for (const c of this.children) { try { c.kill(); } catch {} }
  }
}

module.exports = { HardwareCollector };
