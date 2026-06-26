export type ActionLayerErrorCode =
  | 'E_BAD_PAYLOAD'
  | 'E_BAD_ACTION_ID'
  | 'E_FORBIDDEN'
  | 'E_REPLAY'
  | 'E_OUT_OF_ORDER';

export interface ActionLayerFailure {
  ok: false;
  code: ActionLayerErrorCode;
}

export interface ActionLayerSuccess<T> {
  ok: true;
  value: T;
}

export type ActionLayerResult<T> = ActionLayerSuccess<T> | ActionLayerFailure;

export function ok<T>(value: T): ActionLayerSuccess<T> {
  return { ok: true, value };
}

export function fail(code: ActionLayerErrorCode): ActionLayerFailure {
  return { ok: false, code };
}
