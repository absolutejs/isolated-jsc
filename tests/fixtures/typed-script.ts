type Input = { n: number };

declare const input: unknown;

const inputValue = input as Input;
inputValue.n * 2;
