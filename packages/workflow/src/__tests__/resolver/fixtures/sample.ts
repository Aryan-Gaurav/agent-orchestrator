// ref: hld.md#service-boundaries claim="AuthService owns password hashing"
export class AuthService {
  hash(password: string): Promise<string> {
    return Promise.resolve(password);
  }
}
