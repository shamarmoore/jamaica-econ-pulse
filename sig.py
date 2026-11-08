import inspect, timestral
from timestral import TimestralForecaster
print(inspect.signature(TimestralForecaster.forecast))
print((TimestralForecaster.forecast.__doc__ or '')[:3000])
