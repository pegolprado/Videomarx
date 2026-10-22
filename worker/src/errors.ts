/** Falha temporária: a tarefa volta para a fila (com espera) até o limite de tentativas. */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

/** Falha definitiva, com código e mensagem compreensível para o usuário. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export class CanceledError extends Error {
  constructor() {
    super('Cancelada pelo usuário');
    this.name = 'CanceledError';
  }
}
