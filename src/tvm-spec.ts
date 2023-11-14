export interface Codepage {
    $schema?:     string;
    aliases:      Alias[];
    instructions: Instruction[];
}

export interface Alias {
    alias_of: string;
    /**
     * Free-form markdown description of alias.
     */
    description?: string;
    /**
     * Free-form fift usage description.
     */
    doc_fift?: string;
    /**
     * Free-form description of stack inputs and outputs. Usually the form is `[inputs] -
     * [outputs]` where `[inputs]` are consumed stack values and `outputs` are produced stack
     * values (top of stack is the last value).
     */
    doc_stack?: string;
    mnemonic:   string;
    /**
     * Values of original instruction operands which are fixed in this alias. Currently it can
     * be integer or slice without references which is represented by string of '0' and '1's.
     * Type should be inferred from original instruction operand loaders.
     */
    operands: { [key: string]: any };
}

export interface Instruction {
    /**
     * Information related to bytecode format of an instruction. Assuming that each instruction
     * has format `prefix || operand_1 || operand_2 || ...` (also some operands may be refs, not
     * bitstring part).
     */
    bytecode: BytecodeFormat;
    /**
     * Free-form human-friendly information which should be used for documentation purposes only.
     */
    doc: Documentation;
    /**
     * How instruction is named in [original TVM
     * implementation](https://github.com/ton-blockchain/ton/blob/master/crypto/vm). Not
     * necessarily unique (currently only DEBUG is not unique).
     */
    mnemonic: string;
    /**
     * Information related to usage of stack and registers by instruction.
     */
    value_flow?: ValueFlowOfInstruction;
}

/**
 * Information related to bytecode format of an instruction. Assuming that each instruction
 * has format `prefix || operand_1 || operand_2 || ...` (also some operands may be refs, not
 * bitstring part).
 */
export interface BytecodeFormat {
    /**
     * Free-form bytecode format description.
     */
    doc_opcode?: string;
    /**
     * Describes how to parse operands. Order of objects in this array represents the actual
     * order of operands in instruction. Optional, no operands in case of absence.
     */
    operands?: InstructionOperand[];
    /**
     * In TVM, it is possible for instructions to have overlapping prefixes, so to determine
     * actual instruction it is required to read next `length` bits after prefix as uint `i` and
     * check `from <= i <= to`. Optional, there is no operands check in case of absence.
     */
    operands_range_check?: OperandsRangeCheck;
    /**
     * Prefix to determine next instruction to parse. It is a hex bitstring as in TL-b (suffixed
     * with `_` if bit length is not divisible by 4, trailing `'1' + '0' * x` must be removed).
     */
    prefix: string;
    /**
     * TL-b bytecode format description.
     */
    tlb: string;
}

export interface InstructionOperand {
    loader:       LoaderFunctionForOperand;
    loader_args?: { [key: string]: any };
    /**
     * Allowed chars are `a-zA-Z0-9_`, must not begin with digit or underscore and must not end
     * with underscore.
     */
    name: string;
}

export type LoaderFunctionForOperand = "int" | "uint" | "ref" | "pushint_long" | "subslice";

/**
 * In TVM, it is possible for instructions to have overlapping prefixes, so to determine
 * actual instruction it is required to read next `length` bits after prefix as uint `i` and
 * check `from <= i <= to`. Optional, there is no operands check in case of absence.
 */
export interface OperandsRangeCheck {
    from:   number;
    length: number;
    to:     number;
}

/**
 * Free-form human-friendly information which should be used for documentation purposes only.
 */
export interface Documentation {
    category: string;
    /**
     * Free-form markdown description of instruction.
     */
    description?: string;
    /**
     * Free-form fift usage description.
     */
    fift?:          string;
    fift_examples?: FiftExample[];
    /**
     * Free-form description of gas amount used by instruction.
     */
    gas?: string;
}

export interface FiftExample {
    description?: string;
    fift?:        string;
}

/**
 * Information related to usage of stack and registers by instruction.
 */
export interface ValueFlowOfInstruction {
    /**
     * Free-form description of stack inputs and outputs. Usually the form is `[inputs] -
     * [outputs]` where `[inputs]` are consumed stack values and `outputs` are produced stack
     * values (top of stack is the last value).
     */
    doc_stack?: string;
}

import rawCp0 from './tvm-spec/cp0.json';

export const cp0 = rawCp0 as Codepage;