// GPU pass timing (EXT_disjoint_timer_query_webgl2) and the on-screen stats readout.

export class GpuTimer {
  constructor(renderer) {
    this.gl = renderer.getContext();
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.queue = [];
    this.active = null;
    this.ms = {};
  }

  get supported() { return !!this.ext; }

  begin(label) {
    if (!this.ext || this.active) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, label };
  }

  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.queue.push(this.active);
    this.active = null;
  }

  // Results arrive a few frames late; read whatever is ready.
  poll() {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.queue.length) {
      const { q, label } = this.queue[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      gl.deleteQuery(q);
      this.queue.shift();
      if (disjoint) continue;
      const v = ns / 1e6;
      this.ms[label] = this.ms[label] == null ? v : this.ms[label] * 0.92 + v * 0.08;
    }
    while (this.queue.length > 40) gl.deleteQuery(this.queue.shift().q);
  }

  reset() { this.ms = {}; }
}

export class Stats {
  constructor(el) {
    this.el = el;
    this.frameMs = 16.7;
    this.cpuMs = 0;
    this.worstMs = 0;
    this.last = performance.now();
    this.nextDraw = 0;
  }

  tick(cpuMs) {
    const now = performance.now();
    const dt = now - this.last;
    this.last = now;
    this.frameMs = this.frameMs * 0.93 + dt * 0.07;
    this.cpuMs = this.cpuMs * 0.93 + cpuMs * 0.07;
    this.worstMs = Math.max(this.worstMs * 0.995, dt);
    return now >= this.nextDraw ? ((this.nextDraw = now + 250), true) : false;
  }

  draw({ gpu, renderW, renderH, rays, mapRes, causticsOn }) {
    const f = (v) => (v == null ? '  –  ' : v.toFixed(2).padStart(5));
    const fps = 1000 / this.frameMs;
    const lines = [
      `<b>${fps.toFixed(0).padStart(3)} fps</b>  ${this.frameMs.toFixed(1)} ms  <span class="dim">worst ${this.worstMs.toFixed(1)}</span>`,
      `cpu        ${f(this.cpuMs)} ms`,
    ];
    if (gpu.supported) {
      const c = causticsOn ? gpu.ms.caustics : 0;
      const s = gpu.ms.scene;
      lines.push(
        `gpu caust  ${f(c)} ms`,
        `gpu scene  ${f(s)} ms  <span class="dim">(+ post)</span>`,
        `gpu total  ${f(c != null && s != null ? c + s : null)} ms`,
      );
    } else {
      lines.push('<span class="dim">gpu timers unavailable</span>');
    }
    lines.push(
      `<span class="dim">${renderW}×${renderH} · ${((renderW * renderH) / 1e6).toFixed(1)} MP</span>`,
      `<span class="dim">${causticsOn ? `${(rays / 1000).toFixed(0)}k rays · map ${mapRes}²` : 'caustics off'}</span>`,
      '<span class="dim">fps caps at refresh rate: compare gpu ms</span>',
    );
    this.el.innerHTML = lines.join('\n');
  }
}
