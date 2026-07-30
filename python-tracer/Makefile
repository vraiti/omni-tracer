PREFIX ?= /opt/trace-python
CPYTHON_DIR := cpython
CPYTHON_BIN := $(CPYTHON_DIR)/python
NPROC := $(shell nproc)

.PHONY: all cpython wheel install clean

all: wheel

cpython: $(CPYTHON_BIN)

$(CPYTHON_BIN):
	cd $(CPYTHON_DIR) && ./configure --prefix=$(PREFIX) && $(MAKE) -j$(NPROC)

wheel: $(CPYTHON_BIN)
	$(CPYTHON_BIN) -m ensurepip --upgrade
	$(CPYTHON_BIN) -m pip install maturin
	$(CPYTHON_BIN) -m maturin build --release --interpreter $(CPYTHON_BIN)

install: wheel
	cd $(CPYTHON_DIR) && $(MAKE) install
	$(PREFIX)/bin/python3.12 -m pip install --force-reinstall target/wheels/*.whl
	ln -sf $(PREFIX)/bin/python3.12 /usr/local/bin/trace-python

clean:
	cd $(CPYTHON_DIR) && $(MAKE) clean 2>/dev/null || true
	rm -rf target/
