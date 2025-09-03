import { Decompiler } from '../../src/decompiler';
import { compileFuncToSlice } from '../helpers/func';

describe('Func → Decompiler → Pseudocode snapshot', () => {
  test('simple arithmetic', async () => {
    const code = await compileFuncToSlice(`
      int add(int a, int b) method_id {
        return a + b;
      }
    `);

    await expect((new Decompiler()).decompileSlice(code)).resolves.toMatchSnapshot();
  });

  test('dicts', async () => {
    const code = await compileFuncToSlice(`
      (slice, int) dict_get?(cell dict, int key_len, slice index) asm(index dict key_len) "DICTGET" "NULLSWAPIFNOT";

      (slice, int) get(cell d, slice key) method_id {
        var (val, success?) = d.dict_get?(8, key);
        return (val, success?);
      }
    `);

    await expect((new Decompiler()).decompileSlice(code)).resolves.toMatchSnapshot();
  });

  test('multi arg use', async () => {
    const code = await compileFuncToSlice(`
      int add(int a, int b) method_id {
        return a + b + a + b;
      }
    `);

    await expect((new Decompiler()).decompileSlice(code)).resolves.toMatchSnapshot();
  });

  test('ifs', async () => {
    const code = await compileFuncToSlice(`
      int add(int a, int b) method_id {
        var x = a - 10;
        var y = b + 20;
        var r = a * b;
        if (a > b) {
          r += a / y;
        } else {
          r += b / x;  
        }
        return r;
      }
    `);

    await expect((new Decompiler()).decompileSlice(code)).resolves.toMatchSnapshot();
  });
});
