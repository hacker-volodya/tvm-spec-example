import { decompileFunc } from '../helpers/func';

describe('Func → Decompiler → Pseudocode snapshot', () => {
  test('simple arithmetic', async () => {
    const code = `
      int add(int a, int b) method_id {
        return a + b;
      }
    `;

    await expect(decompileFunc(code)).resolves.toMatchSnapshot();
  });

  test('dicts', async () => {
    const code = `
      (slice, int) dict_get?(cell dict, int key_len, slice index) asm(index dict key_len) "DICTGET" "NULLSWAPIFNOT";

      (slice, int) get(cell d, slice key) method_id {
        var (val, success?) = d.dict_get?(8, key);
        return (val, success?);
      }
    `;

    await expect(decompileFunc(code)).resolves.toMatchSnapshot();
  });
});
