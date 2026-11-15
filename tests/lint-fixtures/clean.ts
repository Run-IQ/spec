// No error: indexed loops, own data, object spread, plain operators.
const list: number[] = [1, 2];
let total = 0;
for (let i = 0; i < list.length; i++) total += list[i] as number;
const merged = { ...{ a: 1 }, b: total };
export const ok = merged.b === 3 && typeof merged.a === 'number';
