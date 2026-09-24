import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { authRouter } from '../modules/auth/auth.routes';
import { catalogRouter } from '../modules/catalog/catalog.routes';
import { customersRouter } from '../modules/customers/customers.routes';
import { employeesRouter } from '../modules/employees/employees.routes';
import { expensesRouter } from '../modules/expenses/expenses.routes';
import { inventoryRouter } from '../modules/inventory/inventory.routes';
import { ordersRouter } from '../modules/orders/orders.routes';
import { platformRouter } from '../modules/platform/platform.routes';
import { purchasingRouter } from '../modules/purchasing/purchasing.routes';
import { reportsRouter } from '../modules/reports/reports.routes';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);

// Everything below this line requires a valid access token.
apiRouter.use(authenticate);

apiRouter.use('/catalog', catalogRouter);
apiRouter.use('/inventory', inventoryRouter);
apiRouter.use('/orders', ordersRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/employees', employeesRouter);
apiRouter.use('/purchase-orders', purchasingRouter);
apiRouter.use('/expenses', expensesRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/platform', platformRouter);
