// Ambient type declaration for the 'input' package, which ships no types.
// Exposes the subset of the API the CLI uses (text + password + confirm).

declare module 'input' {
  const input: {
    text(prompt: string): Promise<string>;
    password(prompt: string): Promise<string>;
    confirm(prompt: string): Promise<boolean>;
  };
  export default input;
}
