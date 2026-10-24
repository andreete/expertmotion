/** Error with a process exit code: 1 verification failed, 2 usage, 3 policy refusal, 4 environment/key. */
export class CliError extends Error {
  constructor(message, exitCode = 2, code = undefined) {
    super(message);
    this.exitCode = exitCode;
    this.code = code;
  }
}
