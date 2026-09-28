export interface PermissionDefinition {
  key: string;
  category: string;
  description: string;
}

/**
 * The single source of truth for every permission the code checks.
 * The seed synchronises the `permissions` table with this array, so adding a
 * permission here and re-running the seed is all it takes to expose it in the
 * roles screen. Never create permissions at runtime: a key the code does not
 * check grants nothing.
 */
export const PERMISSIONS = [
  { key: 'role.view', category: 'rbac', description: 'View roles and the permission catalog' },
  { key: 'role.manage', category: 'rbac', description: 'Create, edit and delete roles' },

  { key: 'staff.view', category: 'staff', description: 'View administrator accounts' },
  { key: 'staff.manage', category: 'staff', description: 'Create, edit and disable administrator accounts' },

  { key: 'trip.view', category: 'trips', description: 'View trips and their details' },
  { key: 'trip.create', category: 'trips', description: 'Create trips' },
  { key: 'trip.update', category: 'trips', description: 'Edit trip details, translations and images' },
  { key: 'trip.publish', category: 'trips', description: 'Publish a trip and change its status' },
  { key: 'trip.cancel', category: 'trips', description: 'Cancel a trip' },
  { key: 'trip.change_price', category: 'trips', description: 'Change the price of a trip that already has reservations' },

  { key: 'trip.budget.view', category: 'costing', description: 'View the trip budget and computed sale price' },
  { key: 'trip.budget.manage', category: 'costing', description: 'Add, edit and delete budget items and margin settings' },

  { key: 'customer.view', category: 'customers', description: 'Search and view customer records' },
  { key: 'customer.manage', category: 'customers', description: 'Create and edit customer records, send invitations' },

  { key: 'reservation.view', category: 'reservations', description: 'View reservations and balances' },
  { key: 'reservation.create', category: 'reservations', description: 'Create reservations on behalf of a customer' },
  { key: 'reservation.cancel', category: 'reservations', description: 'Cancel a reservation and release its seat' },
  { key: 'reservation.risk.view', category: 'reservations', description: 'Receive collection-risk alerts' },

  { key: 'payment.view', category: 'payments', description: 'View payments and receipts' },
  { key: 'payment.register', category: 'payments', description: 'Register cash payments taken at the branch' },
  { key: 'payment.credit.apply', category: 'payments', description: 'Apply or write off a customer credit balance' },

  { key: 'notification.view', category: 'notifications', description: 'View notification campaigns' },
  { key: 'notification.manage', category: 'notifications', description: 'Create, schedule and cancel notification campaigns' },

  { key: 'expense.view', category: 'expenses', description: 'View recorded expenses' },
  { key: 'expense.manage', category: 'expenses', description: 'Record and edit expenses' },

  { key: 'report.view', category: 'reports', description: 'View and export financial reports' },

  { key: 'data.backfill', category: 'operations', description: 'Capture historical trips, reservations and payments with past dates' },
  { key: 'import.manage', category: 'operations', description: 'Upload and confirm CSV imports' },
  { key: 'settings.manage', category: 'operations', description: 'Change system settings' },
] as const satisfies readonly PermissionDefinition[];

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];
