import type { JwtPayload } from 'jsonwebtoken';

declare global {
  namespace Express {
    interface AuthenticatedUser extends JwtPayload {
      email?: string;
    }

    interface Request {
      user?: AuthenticatedUser;
      tenantId?: string;
      machineId?: string;
      managedMachineCredential?: boolean;
      adminRole?: 'tenant_admin' | 'tenant_auditor';
    }
  }
}

export {};
