// ==========================================
// MOTOR DE PRÉSTAMOS (loanEngine.js)
// ==========================================
// Modelo de un préstamo:
//   {
//     id, name, lender,
//     balance:          saldo pendiente de capital en el momento en que lo capturaste (el "ancla"),
//     annualRate:       tasa anual (0.45 = 45%),
//     ivaOnInterest:    true si los intereses causan 16% de IVA,
//     monthlyPayment:   mensualidad,
//     firstPaymentDate: fecha del siguiente pago a partir del ancla,
//     paidHistory:      pagos ya archivados [{ id, date, amount, kind: 'scheduled' | 'extra' }]
//   }
//
// Reglas del motor:
//  - Un pago programado con fecha <= hoy se considera pagado (igual que un gasto fijo) y baja tu saldo de débito.
//  - Los pagos futuros aparecen en el calendario, en la proyección y en tus compromisos.
//  - La tabla es una ESTIMACIÓN: interés del mes = saldo x tasa mensual (+ IVA) por mes completo.
//    Compárala con la tabla de amortización de tu contrato y, si cambia, actualiza el saldo del préstamo.
//  - Al editar los términos o hacer un abono extra, los pagos ya ocurridos se archivan en paidHistory
//    para que tu historial y tu saldo de débito pasados no cambien.
//  Depende de: creditEngine.js (fechas) y debtSimulator.js (simulateDebtAmortization).

function loanUid() {
  return `lp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function loanRound2(n) { return Number(Number(n).toFixed(2)); }

// Adapta el préstamo al formato que espera el simulador
function loanAsDebit(loan) {
  return {
    id: loan.id,
    name: loan.name,
    totalBalance: loan.balance,
    annualInterestRate: loan.annualRate,
    ivaOnInterest: loan.ivaOnInterest !== false,
    startDate: loan.firstPaymentDate,
    firstPaymentDate: loan.firstPaymentDate
  };
}

// Tabla de pagos futuros a partir del ancla
function getLoanSchedule(loan) {
  if (!(loan.balance > 0)) {
    return { error: false, rows: [], totalMonths: 0, totalInterest: 0, finalDate: null };
  }
  const sim = simulateDebtAmortization(loanAsDebit(loan), loan.monthlyPayment);
  if (sim.error) return { error: true, message: sim.message, rows: [] };
  return {
    error: false,
    rows: sim.amortizationSchedule,
    totalMonths: sim.totalMonthsToPay,
    totalInterest: sim.totalInterest,
    finalDate: sim.finalPayoffDate
  };
}

// Pagos programados que siguen "vivos" (descarta fechas ya archivadas para no contar dos veces)
function loanLiveRows(loan) {
  const archived = new Set((loan.paidHistory || []).filter(h => h.kind === 'scheduled').map(h => h.date));
  return getLoanSchedule(loan).rows.filter(r => !archived.has(r.fechaPago));
}

// Saldo de capital pendiente a una fecha: el de la última fila pagada (fecha <= dateStr) o el del ancla
function loanBalanceOn(loan, dateStr) {
  const rows = getLoanSchedule(loan).rows;
  if (rows.length === 0) return loan.balance > 0 ? loan.balance : 0;
  let balance = loan.balance;
  for (const r of rows) {
    if (r.fechaPago <= dateStr) balance = r.saldoRestante; else break;
  }
  return balance;
}

// Resumen del préstamo a una fecha
function getLoanSummary(loan, asOfDateStr) {
  const sched = getLoanSchedule(loan);
  if (sched.error) return { error: true, message: sched.message };
  const rows = sched.rows;
  const future = rows.filter(r => r.fechaPago > asOfDateStr);
  const balance = loanBalanceOn(loan, asOfDateStr);
  return {
    error: false,
    balance: loanRound2(balance),
    paidOff: balance <= 0.005,
    nextPayment: future.length > 0 ? future[0] : null,
    remainingPayments: future.length,
    finalDate: rows.length > 0 ? rows[rows.length - 1].fechaPago : null,
    interestRemaining: loanRound2(future.reduce((sum, r) => sum + r.interesMasIva, 0)),
    totalRemainingToPay: loanRound2(future.reduce((sum, r) => sum + r.pagoMensual, 0)),
    futureRows: future
  };
}

// Pagos programados como eventos de gasto para la línea de tiempo maestra
function getLoanEvents(loans, fromStr, toStr) {
  const events = [];
  for (const loan of (loans || [])) {
    const all = getLoanSchedule(loan).rows;
    const total = all.length;
    const live = new Set(loanLiveRows(loan).map(r => r.fechaPago));
    for (const r of all) {
      if (!live.has(r.fechaPago)) continue;
      if (r.fechaPago < fromStr || r.fechaPago > toStr) continue;
      events.push({
        id: `loan-${loan.id}-${r.fechaPago}`,
        title: `🏦 ${loan.name} (${r.mes}/${total})`,
        type: 'direct_expense',
        amount: r.pagoMensual,
        date: r.fechaPago,
        category: 'Préstamo',
        loanId: loan.id
      });
    }
  }
  return events;
}

// Total pagado a préstamos en [fromStr, toStr]: pagos programados + pagos archivados + abonos extra
function getLoanPaymentsTotal(loans, fromStr, toStr) {
  let total = 0;
  for (const loan of (loans || [])) {
    for (const r of loanLiveRows(loan)) {
      if (r.fechaPago >= fromStr && r.fechaPago <= toStr) total += r.pagoMensual;
    }
    for (const h of (loan.paidHistory || [])) {
      if (h.date >= fromStr && h.date <= toStr) total += h.amount;
    }
  }
  return loanRound2(total);
}

// Pasa al historial los pagos programados con fecha <= asOfDate (y < beforeDate, si se indica)
function archiveLoanPayments(loan, asOfDate, beforeDate) {
  loan.paidHistory = loan.paidHistory || [];
  for (const r of getLoanSchedule(loan).rows) {
    if (r.fechaPago > asOfDate) continue;
    if (beforeDate && r.fechaPago >= beforeDate) continue;
    if (loan.paidHistory.some(h => h.kind === 'scheduled' && h.date === r.fechaPago)) continue;
    loan.paidHistory.push({ id: loanUid(), date: r.fechaPago, amount: r.pagoMensual, kind: 'scheduled' });
  }
}

// Cambia los términos del préstamo. Si cambian saldo, tasa, IVA, mensualidad o fecha del primer pago,
// primero archiva los pagos ya ocurridos para que no se reescriba el pasado.
function updateLoanTerms(loan, terms, asOfDate) {
  const coreChanged =
    loan.balance !== terms.balance ||
    loan.annualRate !== terms.annualRate ||
    (loan.ivaOnInterest !== false) !== (terms.ivaOnInterest !== false) ||
    loan.monthlyPayment !== terms.monthlyPayment ||
    loan.firstPaymentDate !== terms.firstPaymentDate;

  if (coreChanged) archiveLoanPayments(loan, asOfDate, terms.firstPaymentDate);

  loan.name = terms.name;
  loan.lender = terms.lender || '';
  loan.balance = terms.balance;
  loan.annualRate = terms.annualRate;
  loan.ivaOnInterest = terms.ivaOnInterest !== false;
  loan.monthlyPayment = terms.monthlyPayment;
  loan.firstPaymentDate = terms.firstPaymentDate;
  return loan;
}

// Abono extra a capital: archiva lo pagado hasta esa fecha, baja el saldo y mueve el ancla al siguiente pago.
// La mensualidad se queda igual, así que el préstamo termina antes.
function applyLoanExtraPayment(loan, dateStr, amount) {
  if (!(amount > 0)) return { ok: false, error: 'El monto debe ser mayor a 0.' };
  const sched = getLoanSchedule(loan);
  if (sched.error) return { ok: false, error: sched.message };

  const balanceNow = loanBalanceOn(loan, dateStr);
  if (balanceNow <= 0.005) return { ok: false, error: 'Este préstamo ya está liquidado a esa fecha.' };
  if (amount > balanceNow + 0.005) {
    return { ok: false, error: `El abono ($${amount}) es mayor al saldo pendiente a esa fecha ($${loanRound2(balanceNow)}).` };
  }

  const nextRow = sched.rows.find(r => r.fechaPago > dateStr);
  archiveLoanPayments(loan, dateStr, null);
  loan.paidHistory.push({ id: loanUid(), date: dateStr, amount: loanRound2(amount), kind: 'extra' });

  const newBalance = loanRound2(balanceNow - amount);
  loan.balance = newBalance < 0.005 ? 0 : newBalance;
  if (nextRow) loan.firstPaymentDate = nextRow.fechaPago;
  return { ok: true, newBalance: loan.balance };
}
