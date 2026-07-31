PREFIX ?= /opt/trace-python
CPYTHON_DIR := cpython
CPYTHON_BIN := $(CPYTHON_DIR)/python
NPROC := $(shell nproc)

PYTHON ?= python3.12
CC ?= gcc

INCLUDEPY := $(shell $(PYTHON) -c "import sysconfig; print(sysconfig.get_config_var('INCLUDEPY'))")
INTERNAL_INC := $(dir $(INCLUDEPY))include/internal
EXT_SUFFIX := $(shell $(PYTHON) -c "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))")

TRACER_SO := tracer/_tracer$(EXT_SUFFIX)
TRACER_SRCS := $(wildcard csrc/*.c)
TRACER_HDRS := $(wildcard csrc/*.h)

.PHONY: all cpython install clean ext

all: ext

ext: $(TRACER_SO)

$(TRACER_SO): $(TRACER_SRCS) $(TRACER_HDRS)
	$(CC) -O2 -shared -fPIC \
		-I$(INCLUDEPY) \
		-I$(INTERNAL_INC) \
		$(TRACER_SRCS) -o $@

cpython: $(CPYTHON_BIN)

$(CPYTHON_BIN):
	cd $(CPYTHON_DIR) && ./configure --prefix=$(PREFIX) && $(MAKE) -j$(NPROC)

install: cpython ext
	cd $(CPYTHON_DIR) && $(MAKE) install
	install -m 644 $(TRACER_SO) $(PREFIX)/lib/python3.12/site-packages/tracer/
	cp -r tracer $(PREFIX)/lib/python3.12/site-packages/

clean:
	cd $(CPYTHON_DIR) && $(MAKE) clean 2>/dev/null || true
	rm -f $(TRACER_SO)
