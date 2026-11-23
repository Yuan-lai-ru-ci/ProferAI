/** 独立Core本机owner账号操作；不得通过配对/LAN业务授权调用。 */
export type CoreAccountOperation = 'login' | 'register' | 'logout' | 'status' | 'teamAuth' | 'serverInfo' | 'registrationOptions' | 'sendRegistrationOtp' | 'verifyRegistrationOtp' | 'listDevices' | 'revokeDevice' | 'refresh'
