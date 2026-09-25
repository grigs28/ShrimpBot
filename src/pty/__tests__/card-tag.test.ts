import { describe, it, expect } from 'vitest';
import { cardTagPrefix } from '../card-tag.js';

describe('cardTagPrefix（飞书卡片标题的目录名前缀）', () => {
  it('普通路径取末段：/opt/loging → "[loging] "', () => {
    expect(cardTagPrefix('/opt/loging')).toBe('[loging] ');
  });

  it('尾斜杠同样处理', () => {
    expect(cardTagPrefix('/opt/loging/')).toBe('[loging] ');
  });

  it('根路径 / → 空串（不加前缀）', () => {
    expect(cardTagPrefix('/')).toBe('');
  });

  it('空 / 未设置 → 空串', () => {
    expect(cardTagPrefix('')).toBe('');
    expect(cardTagPrefix(undefined)).toBe('');
  });
});
