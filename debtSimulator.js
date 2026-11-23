// ==========================================
// 1. SIMULADOR DE AMORTIZACIÓN (CON ABONOS EXTRAORDINARIOS)
// ==========================================

function simulateDebtAmortization(debt, monthlyPayment, extraordinaryPayments = []) {
  let balance = debt.totalBalance;
  // ?? y no ||: una tasa de 0% es válida y no debe convertirse en 50%
  const annualRate = debt.annualInterestRate ?? 0.50;
  // Tasa mensual; por defecto los intereses causan IVA (16%). Con debt.ivaOnInterest === false no se aplica.
  const monthlyRate = (annualRate / 12) * (debt.ivaOnInterest === false ? 1 : 1.16);
  
  const schedule = [];
  let totalInterestPaid = 0;
  let totalPaid = 0;
  let monthCount = 0;
  const maxMonths = 360;

  let currentYear, currentMonth, currentDay;
  if (debt.startDate) {
    const parts = debt.startDate.split('-').map(Number);
    currentYear = parts[0];
    currentMonth = parts[1] - 1;
    currentDay = parts[2];
  } else {
    const now = new Date();
    currentYear = now.getFullYear();
    currentMonth = now.getMonth();
    currentDay = now.getDate();
  }

  // Si se indica debt.firstPaymentDate, los pagos caen en ese día de cada mes empezando por esa fecha
  // (en lugar de "un mes después de startDate").
  let fixedYear, fixedMonth, fixedDay;
  const useFixedFirst = !!debt.firstPaymentDate;
  if (useFixedFirst) {
    const fp = debt.firstPaymentDate.split('-').map(Number);
    fixedYear = fp[0]; fixedMonth = fp[1] - 1; fixedDay = fp[2];
  }

  const firstMonthInterest = balance * monthlyRate;
  if (monthlyPayment <= firstMonthInterest) {
    return {
      error: true,
      message: `⚠️ PAGO INSUFICIENTE en ${debt.name}: Tu abono de $${monthlyPayment} no cubre los intereses del primer mes ($${Number(firstMonthInterest.toFixed(2))}).`
    };
  }

  while (balance > 0 && monthCount < maxMonths) {
    monthCount++;

    const paymentDateObj = useFixedFirst
      ? createSafeDate(fixedYear, fixedMonth + (monthCount - 1), fixedDay)
      : createSafeDate(currentYear, currentMonth + monthCount, currentDay);
    const paymentDateStr = formatDate(paymentDateObj);

    // 1. Interés e IVA del mes
    const interest = balance * monthlyRate;
    
    // 2. Revisar si hay un abono extraordinario programado para este mes/fecha exacta
    const extraPaymentObj = extraordinaryPayments.find(ep => ep.date === paymentDateStr);
    const extraAmount = extraPaymentObj ? extraPaymentObj.amount : 0;

    // 3. Abono total del mes (Mensual + Extraordinario a capital)
    const totalMonthCommitment = monthlyPayment + extraAmount;
    const paymentThisMonth = Math.min(totalMonthCommitment, balance + interest);
    const principal = paymentThisMonth - interest;
    
    // 4. Nuevo saldo
    balance = Math.max(0, balance - principal);
    if (balance < 0.005) balance = 0; // evita un pago "fantasma" de centavos por redondeo de punto flotante
    totalInterestPaid += interest;
    totalPaid += paymentThisMonth;

    schedule.push({
      mes: monthCount,
      fechaPago: paymentDateStr,
      pagoMensual: Number(paymentThisMonth.toFixed(2)),
      abonoExtra: extraAmount,
      interesMasIva: Number(interest.toFixed(2)),
      abonoACapital: Number(principal.toFixed(2)),
      saldoRestante: Number(balance.toFixed(2))
    });

    if (balance === 0) break;
  }

  const finalDate = schedule.length > 0 ? schedule[schedule.length - 1].fechaPago : debt.startDate;

  return {
    error: false,
    debtId: debt.id,
    debtName: debt.name,
    initialBalance: debt.totalBalance,
    monthlyPayment: monthlyPayment,
    totalMonthsToPay: monthCount,
    finalPayoffDate: finalDate,
    totalInterest: Number(totalInterestPaid.toFixed(2)),
    totalAmountPaid: Number(totalPaid.toFixed(2)),
    amortizationSchedule: schedule
  };
}

// ==========================================
// 2. COMPARADOR DE ESCENARIOS CON ABONOS EXTRA
// ==========================================

function compareDebtScenarios(debt, basePayment, extraPaymentAmount, extraordinaryPayments = []) {
  const baseSimulation = simulateDebtAmortization(debt, basePayment, extraordinaryPayments);
  const acceleratedPayment = basePayment + extraPaymentAmount;
  const acceleratedSimulation = simulateDebtAmortization(debt, acceleratedPayment, extraordinaryPayments);

  if (baseSimulation.error || acceleratedSimulation.error) {
    return { error: true, message: "Una de las simulaciones tiene un pago insuficiente." };
  }

  const monthsSaved = baseSimulation.totalMonthsToPay - acceleratedSimulation.totalMonthsToPay;
  const interestSaved = baseSimulation.totalInterest - acceleratedSimulation.totalInterest;

  return {
    debtName: debt.name,
    escenarioBase: {
      pagoMensual: basePayment,
      meses: baseSimulation.totalMonthsToPay,
      fechaFinal: baseSimulation.finalPayoffDate,
      interesesTotales: baseSimulation.totalInterest
    },
    escenarioAcelerado: {
      pagoMensual: acceleratedPayment,
      meses: acceleratedSimulation.totalMonthsToPay,
      fechaFinal: acceleratedSimulation.finalPayoffDate,
      interesesTotales: acceleratedSimulation.totalInterest
    },
    beneficio: {
      mesesAhorrados: monthsSaved,
      dineroInteresesAhorrados: Number(interestSaved.toFixed(2))
    }
  };
}

// ==========================================
// 3. ESTRATEGIAS DE PAGO MULTIDEUDA (AVALANCHA Y BOLA DE NIEVE)
// ==========================================

// Distribuye un presupuesto global entre varias deudas según la estrategia elegida
function simulateMultiDebtStrategy(debts, totalMonthlyBudget, strategy = "avalanche") {
  // Copia de trabajo de las deudas para no mutar los datos originales
  let activeDebts = debts.map(d => ({
    ...d,
    currentBalance: d.totalBalance,
    monthlyRate: ((d.annualInterestRate ?? 0.50) / 12) * (d.ivaOnInterest === false ? 1 : 1.16),
    paidOffMonth: null,
    history: []
  }));

  // Ordenar las deudas según la estrategia:
  // - "avalanche": Mayor tasa de interés primero
  // - "snowball": Menor saldo total primero
  activeDebts.sort((a, b) => {
    if (strategy === "avalanche") {
      return b.annualInterestRate - a.annualInterestRate;
    } else {
      return a.totalBalance - b.totalBalance;
    }
  });

  let monthCount = 0;
  const maxMonths = 360;
  const masterLog = [];

  while (activeDebts.some(d => d.currentBalance > 0) && monthCount < maxMonths) {
    monthCount++;
    let availableBudget = totalMonthlyBudget;
    let monthlySummary = { mes: monthCount, pagos: [] };

    // Paso 1: Cubrir el pago mínimo obligatorio de todas las deudas activas
    let totalMinimums = 0;
    for (const debt of activeDebts) {
      if (debt.currentBalance > 0) {
        totalMinimums += (debt.minimumPayment || 0);
      }
    }

    if (totalMonthlyBudget < totalMinimums) {
      return {
        error: true,
        message: `⚠️ Presupuesto insuficiente: Tu presupuesto mensual de $${totalMonthlyBudget} no alcanza para cubrir los pagos mínimos obligatorios ($${totalMinimums}).`
      };
    }

    // Distribuir pagos mínimos y calcular intereses
    let poolForTarget = availableBudget; // Lo que sobra se va al objetivo principal

    for (const debt of activeDebts) {
      if (debt.currentBalance <= 0) continue;

      const interest = debt.currentBalance * debt.monthlyRate;
      let payment = debt.minimumPayment || debt.totalBalance * 0.05; // Mínimo o 5% por defecto
      
      // Asegurarnos de no pagar más del saldo + intereses
      payment = Math.min(payment, debt.currentBalance + interest);
      poolForTarget -= payment;

      const principal = payment - interest;
      debt.currentBalance = Math.max(0, debt.currentBalance - principal);

      monthlySummary.pagos.push({
        deuda: debt.name,
        pagoAsignado: Number(payment.toFixed(2)),
        interes: Number(interest.toFixed(2)),
        capital: Number(principal.toFixed(2)),
        saldoRestante: Number(debt.currentBalance.toFixed(2))
      });

      if (debt.currentBalance === 0 && !debt.paidOffMonth) {
        debt.paidOffMonth = monthCount;
      }
    }

    // Paso 2: El dinero sobrante (bola de nieve) se inyecta por completo a la primera deuda activa según la prioridad
    if (poolForTarget > 0) {
      const targetDebt = activeDebts.find(d => d.currentBalance > 0);
      if (targetDebt) {
        const interest = targetDebt.currentBalance * targetDebt.monthlyRate;
        const extraPayment = Math.min(poolForTarget, targetDebt.currentBalance + interest);
        const extraPrincipal = extraPayment - interest;
        
        targetDebt.currentBalance = Math.max(0, targetDebt.currentBalance - extraPrincipal);

        // Actualizar el registro del pago de esa deuda en el resumen del mes
        const targetLog = monthlySummary.pagos.find(p => p.deuda === targetDebt.name);
        if (targetLog) {
          targetLog.pagoAsignado = Number((targetLog.pagoAsignado + extraPayment).toFixed(2));
          targetLog.capital = Number((targetLog.capital + extraPrincipal).toFixed(2));
          targetLog.saldoRestante = Number(targetDebt.currentBalance.toFixed(2));
        }

        if (targetDebt.currentBalance === 0 && !targetDebt.paidOffMonth) {
          targetDebt.paidOffMonth = monthCount;
        }
      }
    }

    masterLog.push(monthlySummary);
  }

  return {
    error: false,
    strategyUsed: strategy === "avalanche" ? "Método Avalancha (Por Tasa de Interés Alta)" : "Método Bola de Nieve (Por Saldo Menor)",
    totalMonthsToDebtFree: monthCount,
    debtMilestones: activeDebts.map(d => ({
      deuda: d.name,
      mesEnQueSeLiquida: d.paidOffMonth
    })),
    timelineLog: masterLog
  };
}

// ==========================================
// 4. PRUEBA DE EJECUCIÓN EN CONSOLA
// ==========================================

const deudasMultiplesDemo = [
  { id: "d1", name: "Tarjeta BBVA", totalBalance: 12000, annualInterestRate: 0.65, minimumPayment: 1200 },
  { id: "d2", name: "Préstamo Personal", totalBalance: 35000, annualInterestRate: 0.45, minimumPayment: 2000 },
  { id: "d3", name: "Tarjeta Nu", totalBalance: 5000, annualInterestRate: 0.58, minimumPayment: 600 }
];

// Presupuesto global que puedes destinar cada mes para matar todas tus deudas
const presupuestoGlobalMensual = 6000;

console.log("=== SIMULACIÓN ESTRATEGIA AVALANCHA (MATEMÁTICA) ===");
const resultadoAvalancha = simulateMultiDebtStrategy(deudasMultiplesDemo, presupuestoGlobalMensual, "avalanche");
console.log(`¡Libre de deudas en ${resultadoAvalancha.totalMonthsToDebtFree} meses!`);
console.table(resultadoAvalancha.debtMilestones);

console.log("=== SIMULADOR DE ABONOS EXTRAORDINARIOS (EJ. AGUINALDO) ===" );
const prestamoConAguinaldo = { id: "p1", name: "Crédito Personal", totalBalance: 50000, annualInterestRate: 0.50, startDate: "2026-10-16" };
const abonosExtra = [
  { date: "2026-12-15", amount: 10000 } // Inyectas $10,000 extra en diciembre
];
const simConExtra = simulateDebtAmortization(prestamoConAguinaldo, 3500, abonosExtra);
console.table([{
  "Meses Totales": simConExtra.totalMonthsToPay,
  "Fecha Liquidación": simConExtra.finalPayoffDate,
  "Intereses Totales": simConExtra.totalInterest
}]);