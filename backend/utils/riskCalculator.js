/**
 * Smart Risk Badge Calculator
 * Calculates risk badges based on filter success rates and odds
 */

// Success rates for 8 filters (percentage)
const FILTER_SUCCESS_RATES = {
  'filter1': 85,  // %85 başarı oranı
  'filter2': 78,  // %78 başarı oranı
  'filter3': 72,  // %72 başarı oranı
  'filter4': 68,  // %68 başarı oranı
  'filter5': 65,  // %65 başarı oranı
  'filter6': 62,  // %62 başarı oranı
  'filter7': 58,  // %58 başarı oranı
  'filter8': 55,  // %55 başarı oranı
};

// Risk badge configurations
const RISK_CONFIGS = {
  ULTRA_SAFE: {
    badge: 'ULTRA_SAFE',
    score: 1,
    color: '#00C853',      // Green
    emoji: '🟢',
    description_tr: 'İstatistiksel olarak geçmiş performansa göre yüksek başarı olasılığı bulunmaktadır. Risk analizi sonucunda tahmini başarı oranı %80 ve üzeridir. Yatırım yapmadan önce kendi risk değerlendirmenizi yapmanız önerilir.',
    estimated_time: '5-10 dk',
    min_success_rate: 80,
    max_success_rate: 100
  },
  LOW_RISK: {
    badge: 'LOW_RISK',
    score: 2,
    color: '#64DD17',      // Light Green
    emoji: '🟡',
    description_tr: 'Geçmiş performans verilerine göre iyi başarı olasılığı görülmektedir. İstatistiksel analiz sonucunda tahmini başarı oranı %70-79 aralığındadır. Risk değerlendirmesi yaparak karar vermeniz önerilir.',
    estimated_time: '10-15 dk',
    min_success_rate: 70,
    max_success_rate: 79
  },
  MEDIUM_RISK: {
    badge: 'MEDIUM_RISK',
    score: 3,
    color: '#FFC107',      // Amber/Yellow
    emoji: '🟠',
    description_tr: 'Risk analizi sonucunda orta seviye risk tespit edilmiştir. İstatistiksel olarak geçmiş performansa göre tahmini başarı oranı %60-69 aralığındadır. Olası sonuçlar hakkında dikkatli değerlendirme yapmanız önerilir.',
    estimated_time: '15-20 dk',
    min_success_rate: 60,
    max_success_rate: 69
  },
  HIGH_RISK: {
    badge: 'HIGH_RISK',
    score: 4,
    color: '#FF5722',      // Deep Orange
    emoji: '🔴',
    description_tr: 'Yüksek risk seviyesi tespit edilmiştir. İstatistiksel analiz sonucunda tahmini başarı oranı %50-59 aralığındadır. Geçmiş performans verilerine göre dikkatli olunması ve kapsamlı risk değerlendirmesi yapılması önerilir.',
    estimated_time: '20-30 dk',
    min_success_rate: 50,
    max_success_rate: 59
  },
  VERY_HIGH_RISK: {
    badge: 'VERY_HIGH_RISK',
    score: 5,
    color: '#D32F2F',      // Red
    emoji: '⚫',
    description_tr: 'Çok yüksek risk seviyesi tespit edilmiştir. İstatistiksel olarak geçmiş performansa göre tahmini başarı oranı %50\'nin altındadır. Risk analizi sonucunda bu tahmin sadece deneyimli kullanıcılar için uygundur. Yatırım yapmadan önce detaylı değerlendirme yapmanız şiddetle önerilir.',
    estimated_time: '30+ dk',
    min_success_rate: 0,
    max_success_rate: 49
  }
};

/**
 * Calculate Expected Value (EV) based on success rate and odds
 * Formula: EV = (Success Rate / 100) * (Odds - 1) - (1 - Success Rate / 100) * 1
 * 
 * @param {number} successRate - Success rate percentage (0-100)
 * @param {number} odds - Decimal odds (e.g., 2.5)
 * @returns {number} Expected Value (can be negative)
 */
function calculateExpectedValue(successRate, odds) {
  if (!successRate || !odds || odds <= 0) {
    return 0;
  }
  
  const probability = successRate / 100;
  const winAmount = odds - 1;  // Net profit if win
  const lossAmount = 1;        // Amount lost if lose
  
  const ev = (probability * winAmount) - ((1 - probability) * lossAmount);
  
  // Round to 2 decimal places
  return Math.round(ev * 100) / 100;
}

/**
 * Get risk badge based on success rate
 * 
 * @param {number} successRate - Success rate percentage (0-100)
 * @returns {object} Risk configuration object
 */
function getRiskBadgeBySuccessRate(successRate) {
  if (successRate >= 80) {
    return RISK_CONFIGS.ULTRA_SAFE;
  } else if (successRate >= 70) {
    return RISK_CONFIGS.LOW_RISK;
  } else if (successRate >= 60) {
    return RISK_CONFIGS.MEDIUM_RISK;
  } else if (successRate >= 50) {
    return RISK_CONFIGS.HIGH_RISK;
  } else {
    return RISK_CONFIGS.VERY_HIGH_RISK;
  }
}

/**
 * Calculate smart risk for a prediction
 * 
 * @param {string} filterName - Filter name (filter1, filter2, etc.)
 * @param {number} odds - Decimal odds (e.g., 2.5)
 * @returns {object} Risk calculation result
 */
function calculateSmartRisk(filterName, odds) {
  // Default values if invalid input
  if (!filterName || !FILTER_SUCCESS_RATES[filterName]) {
    // Default to MEDIUM_RISK if filter not found
    const defaultConfig = RISK_CONFIGS.MEDIUM_RISK;
    return {
      filter_name: filterName || 'unknown',
      risk_badge: defaultConfig.badge,
      risk_score: defaultConfig.score,
      risk_color: defaultConfig.color,
      risk_emoji: defaultConfig.emoji,
      success_rate: 65,
      expected_value: calculateExpectedValue(65, odds || 0),
      description_tr: defaultConfig.description_tr,
      estimated_time: defaultConfig.estimated_time,
      auto_calculated: true
    };
  }
  
  const successRate = FILTER_SUCCESS_RATES[filterName];
  const riskConfig = getRiskBadgeBySuccessRate(successRate);
  const expectedValue = calculateExpectedValue(successRate, odds || 0);
  
  return {
    filter_name: filterName,
    risk_badge: riskConfig.badge,
    risk_score: riskConfig.score,
    risk_color: riskConfig.color,
    risk_emoji: riskConfig.emoji,
    success_rate: successRate,
    expected_value: expectedValue,
    description_tr: riskConfig.description_tr,
    estimated_time: riskConfig.estimated_time,
    auto_calculated: true
  };
}

/**
 * Get risk configuration by badge name
 * 
 * @param {string} badge - Risk badge name (ULTRA_SAFE, LOW_RISK, etc.)
 * @returns {object|null} Risk configuration object or null if not found
 */
function getRiskConfig(badge) {
  const badgeUpper = badge ? badge.toUpperCase() : '';
  
  // Find config by badge name
  for (const key in RISK_CONFIGS) {
    if (RISK_CONFIGS[key].badge === badgeUpper) {
      return RISK_CONFIGS[key];
    }
  }
  
  return null;
}

/**
 * Get all available filters
 * 
 * @returns {array} Array of filter names
 */
function getAvailableFilters() {
  return Object.keys(FILTER_SUCCESS_RATES);
}

/**
 * Get all risk badges
 * 
 * @returns {array} Array of risk badge configurations
 */
function getAllRiskBadges() {
  return Object.values(RISK_CONFIGS);
}

module.exports = {
  calculateSmartRisk,
  getRiskConfig,
  calculateExpectedValue,
  getRiskBadgeBySuccessRate,
  getAvailableFilters,
  getAllRiskBadges,
  FILTER_SUCCESS_RATES,
  RISK_CONFIGS
};

