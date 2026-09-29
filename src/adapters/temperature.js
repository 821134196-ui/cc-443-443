'use strict';

/**
 * 模拟温度适配器：为每台热水设备提供水温读数。
 * 生产环境可替换为真实物联网网关实现（保持 read(facilityId) 接口不变）。
 * 读数在 36~43.5℃ 间随机游走，偶发尖峰超温；测试可用 setOverride 注入指定温度。
 */
class SimulatedTemperatureAdapter {
  constructor(opts = {}) {
    this.base = opts.base ?? 40;
    this.spikeChance = opts.spikeChance ?? 0.02;
    this._state = new Map();     // facilityId -> 上次读数
    this._override = new Map();  // facilityId -> 固定读数（测试/演示用）
  }

  setOverride(facilityId, celsius) {
    if (celsius === null || celsius === undefined) this._override.delete(facilityId);
    else this._override.set(facilityId, Number(celsius));
  }

  read(facilityId) {
    if (this._override.has(facilityId)) return this._override.get(facilityId);
    const prev = this._state.get(facilityId) ?? this.base;
    let next = prev + (Math.random() * 1.6 - 0.8);
    next = Math.max(36, Math.min(43.5, next));
    if (Math.random() < this.spikeChance) next += 6 + Math.random() * 3; // 偶发超温尖峰
    next = Math.round(next * 10) / 10;
    this._state.set(facilityId, next);
    return next;
  }
}

module.exports = { SimulatedTemperatureAdapter };
