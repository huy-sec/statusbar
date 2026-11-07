// CPU, RAM, temperature, NVIDIA GPU, and the Janas process's own CPU/memory.
// Nothing here needs admin rights.
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount
while ($true) {
  $tz = Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation |
        ForEach-Object { if ($_.HighPrecisionTemperature) { $_.HighPrecisionTemperature / 10 - 273.15 } else { $_.Temperature - 273.15 } }
  $temp = if ($tz) { [math]::Round(($tz | Measure-Object -Maximum).Maximum, 1) } else { $null }
  $p = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name='janas-server'"
  $j = $null
  if ($p) { $p = @($p)[0]; $j = @{ cpu = [math]::Round($p.PercentProcessorTime / $cores, 1); mem = [int64]$p.WorkingSetPrivate } }
  @{ temp = $temp; janas = $j } | ConvertTo-Json -Compress
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

  startNvidia() {
    const child = spawn('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
      '--format=csv,noheader,nounits', '-lms', '2000',
    ], { windowsHide: true });
    this.children.push(child);
    child.on('error', () => { this.state.gpu = null; });
    child.on('exit', () => this.respawn(this.startNvidia, 15000));
    this.lines(child, (line) => {
      const [name, util, memUsed, memTotal, temp, power] = line.split(',').map((s) => s.trim());
      const num = (s) => (s === undefined || isNaN(Number(s)) ? null : Number(s));
      this.state.gpu = {
        name: name.replace(/^NVIDIA (GeForce )?/, ''),
        util: num(util), memUsed: num(memUsed), memTotal: num(memTotal),
        temp: num(temp), power: num(power),
      };
      this.emit('update');
    });
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
